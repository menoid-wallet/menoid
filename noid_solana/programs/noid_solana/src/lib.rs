use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;
use num_bigint::BigUint;

pub mod verifying_keys;
use verifying_keys::{DEPOSIT_VK, TRANSFER_VK, WITHDRAW_VK};

declare_id!("3wxDTqw42qqftiAcTZ6kLeNtepuSmB1mR1skrEcwD9SC");

pub const EMPTY_ROOT: [u8; 32] = [
    0x21, 0x34, 0xe7, 0x6a, 0xc5, 0xd2, 0x1a, 0xab, 0x18, 0x6c, 0x2b, 0xe1, 0xdd, 0x8f, 0x84, 0xee,
    0x88, 0x0a, 0x1e, 0x46, 0xea, 0xf7, 0x12, 0xf9, 0xd3, 0x71, 0xb6, 0xdf, 0x22, 0x19, 0x1f, 0x3e
];

#[program]
pub mod noid_solana {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        relayer_zk_pubkey: [u8; 32],
        relayer_address: Pubkey,
    ) -> Result<()> {
        let pool_state = &mut ctx.accounts.pool_state;
        pool_state.admin = ctx.accounts.admin.key();
        pool_state.relayer_address = relayer_address;
        pool_state.relayer_zk_pubkey = relayer_zk_pubkey;
        pool_state.locked_balance = 0;
        pool_state.root_history = vec![EMPTY_ROOT; 100];
        pool_state.root_ptr = 0;
        pool_state.next_idx = 0;
        pool_state.current_root = EMPTY_ROOT;
        pool_state.bump = ctx.bumps.pool_state;
        Ok(())
    }

    pub fn set_relayer(
        ctx: Context<SetRelayer>,
        relayer_zk_pubkey: [u8; 32],
        relayer_address: Pubkey,
    ) -> Result<()> {
        let pool_state = &mut ctx.accounts.pool_state;
        pool_state.relayer_zk_pubkey = relayer_zk_pubkey;
        pool_state.relayer_address = relayer_address;
        Ok(())
    }

    pub fn deposit(
        ctx: Context<Deposit>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        amount: u64,
        c1: [u8; 32],
        c2: [u8; 32],
        root1: [u8; 32],
        root2: [u8; 32],
    ) -> Result<()> {
        require!(amount > 0, ErrorCode::ZeroAmount);
        require!(c1 != [0u8; 32] && c2 != [0u8; 32], ErrorCode::InvalidCommitment);
        require!(c1 != c2, ErrorCode::DuplicateCommitment);

        // Prepare public inputs
        let amount_be = u64_to_be32(amount);
        let public_inputs: [[u8; 32]; 4] = [
            amount_be,
            c1,
            c2,
            ctx.accounts.pool_state.relayer_zk_pubkey,
        ];

        // Verify ZK Proof
        let mut verifier = Groth16Verifier::new(
            &proof_a,
            &proof_b,
            &proof_c,
            &public_inputs,
            &DEPOSIT_VK,
        ).map_err(|_| error!(ErrorCode::ProofFailed))?;

        verifier.verify().map_err(|_| error!(ErrorCode::ProofFailed))?;

        // Transfer SOL from user to vault PDA
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.user.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_context, amount)?;

        // Update tree forest and commitments
        let pool_state = &mut ctx.accounts.pool_state;
        pool_state.locked_balance += amount;

        // Insert c1
        let ptr1 = pool_state.root_ptr as usize;
        pool_state.root_history[ptr1] = root1;
        pool_state.root_ptr = (pool_state.root_ptr + 1) % 100;
        pool_state.next_idx += 1;

        // Insert c2
        let ptr2 = pool_state.root_ptr as usize;
        pool_state.root_history[ptr2] = root2;
        pool_state.root_ptr = (pool_state.root_ptr + 1) % 100;
        pool_state.next_idx += 1;
        pool_state.current_root = root2;

        emit!(NoteCreatedEvent {
            pool_id: 0,
            commitment: c1,
        });
        emit!(NoteCreatedEvent {
            pool_id: 0,
            commitment: c2,
        });

        // The commitment PDAs are initialized by the Anchor framework automatically
        ctx.accounts.commitment1.bump = ctx.bumps.commitment1;
        ctx.accounts.commitment2.bump = ctx.bumps.commitment2;

        Ok(())
    }

    pub fn transfer<'info>(
        ctx: Context<'_, '_, '_, 'info, Transfer<'info>>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        enabled: [u8; 4],
        roots: [[u8; 32]; 4],
        nullifiers: [[u8; 32]; 4],
        output_enabled: [u8; 3],
        c_outs: [[u8; 32]; 3],
        output_roots: [[u8; 32]; 3],
    ) -> Result<()> {
        let pool_state = &mut ctx.accounts.pool_state;

        // Verify inputs
        verify_tree_roots(pool_state, &enabled, &roots)?;

        // Prepare public inputs
        let mut public_inputs: [[u8; 32]; 19] = [[0u8; 32]; 19];
        public_inputs[0] = pool_state.relayer_zk_pubkey;
        for i in 0..4 {
            public_inputs[1 + i] = u8_to_be32(enabled[i]);
            public_inputs[5 + i] = roots[i];
            public_inputs[9 + i] = nullifiers[i];
        }
        for j in 0..3 {
            public_inputs[13 + j] = u8_to_be32(output_enabled[j]);
            public_inputs[16 + j] = c_outs[j];
        }

        // Verify ZK Proof
        let mut verifier = Groth16Verifier::new(
            &proof_a,
            &proof_b,
            &proof_c,
            &public_inputs,
            &TRANSFER_VK,
        ).map_err(|_| error!(ErrorCode::ProofFailed))?;

        verifier.verify().map_err(|_| error!(ErrorCode::ProofFailed))?;

        // Process nullifiers & commitments in remaining accounts
        let mut remaining_accounts_iter = ctx.remaining_accounts.iter();
        let program_id = ctx.program_id;

        // Spend nullifiers
        for i in 0..4 {
            if enabled[i] == 1 {
                let null_acc_info = remaining_accounts_iter.next().ok_or(ErrorCode::MissingAccount)?;
                let n = nullifiers[i];
                let (expected_pda, bump) = Pubkey::find_program_address(&[b"nullifier", n.as_ref()], program_id);
                require_keys_eq!(null_acc_info.key(), expected_pda, ErrorCode::InvalidPda);

                create_pda_account(
                    &ctx.accounts.relayer,
                    null_acc_info,
                    &[b"nullifier", n.as_ref(), &[bump]],
                    8,
                    program_id,
                    &ctx.accounts.system_program,
                )?;
                emit!(NullifierSpentEvent { nullifier: n });
            }
        }

        // Insert new commitments
        let mut last_root = pool_state.current_root;
        for j in 0..3 {
            if output_enabled[j] == 1 {
                let c_acc_info = remaining_accounts_iter.next().ok_or(ErrorCode::MissingAccount)?;
                let c = c_outs[j];
                let (expected_pda, bump) = Pubkey::find_program_address(&[b"commitment", c.as_ref()], program_id);
                require_keys_eq!(c_acc_info.key(), expected_pda, ErrorCode::InvalidPda);

                create_pda_account(
                    &ctx.accounts.relayer,
                    c_acc_info,
                    &[b"commitment", c.as_ref(), &[bump]],
                    8,
                    program_id,
                    &ctx.accounts.system_program,
                )?;

                // Update Merkle tree
                last_root = output_roots[j];
                let ptr = pool_state.root_ptr as usize;
                pool_state.root_history[ptr] = last_root;
                pool_state.root_ptr = (pool_state.root_ptr + 1) % 100;
                pool_state.next_idx += 1;

                emit!(NoteCreatedEvent {
                    pool_id: 0,
                    commitment: c,
                });
            }
        }
        pool_state.current_root = last_root;

        Ok(())
    }

    pub fn withdraw<'info>(
        ctx: Context<'_, '_, '_, 'info, Withdraw<'info>>,
        proof_a: [u8; 64],
        proof_b: [u8; 128],
        proof_c: [u8; 64],
        enabled: [u8; 4],
        roots: [[u8; 32]; 4],
        nullifiers: [[u8; 32]; 4],
        receiver: Pubkey,
        withdraw_amount: u64,
        out_enabled: [u8; 2],
        c_outs: [[u8; 32]; 2],
        output_roots: [[u8; 32]; 2],
    ) -> Result<()> {
        let pool_state = &mut ctx.accounts.pool_state;
        require!(withdraw_amount > 0, ErrorCode::ZeroAmount);
        require!(pool_state.locked_balance >= withdraw_amount, ErrorCode::InsufficientBalance);

        // Verify inputs
        verify_tree_roots(pool_state, &enabled, &roots)?;

        // Prepare public inputs
        let receiver_mod_p = pubkey_to_u256_mod_p(&receiver);
        let mut public_inputs: [[u8; 32]; 19] = [[0u8; 32]; 19];
        public_inputs[0] = receiver_mod_p;
        public_inputs[1] = pool_state.relayer_zk_pubkey;
        for i in 0..4 {
            public_inputs[2 + i] = u8_to_be32(enabled[i]);
            public_inputs[6 + i] = roots[i];
            public_inputs[10 + i] = nullifiers[i];
        }
        public_inputs[14] = u64_to_be32(withdraw_amount);
        for j in 0..2 {
            public_inputs[15 + j] = u8_to_be32(out_enabled[j]);
            public_inputs[17 + j] = c_outs[j];
        }

        // Verify ZK Proof
        let mut verifier = Groth16Verifier::new(
            &proof_a,
            &proof_b,
            &proof_c,
            &public_inputs,
            &WITHDRAW_VK,
        ).map_err(|_| error!(ErrorCode::ProofFailed))?;

        verifier.verify().map_err(|_| error!(ErrorCode::ProofFailed))?;

        // Process nullifiers & commitments in remaining accounts
        let mut remaining_accounts_iter = ctx.remaining_accounts.iter();
        let program_id = ctx.program_id;

        // Spend nullifiers
        for i in 0..4 {
            if enabled[i] == 1 {
                let null_acc_info = remaining_accounts_iter.next().ok_or(ErrorCode::MissingAccount)?;
                let n = nullifiers[i];
                let (expected_pda, bump) = Pubkey::find_program_address(&[b"nullifier", n.as_ref()], program_id);
                require_keys_eq!(null_acc_info.key(), expected_pda, ErrorCode::InvalidPda);

                create_pda_account(
                    &ctx.accounts.relayer,
                    null_acc_info,
                    &[b"nullifier", n.as_ref(), &[bump]],
                    8,
                    program_id,
                    &ctx.accounts.system_program,
                )?;
                emit!(NullifierSpentEvent { nullifier: n });
            }
        }

        // Insert new commitments (change outputs)
        let mut last_root = pool_state.current_root;
        for j in 0..2 {
            if out_enabled[j] == 1 {
                let c_acc_info = remaining_accounts_iter.next().ok_or(ErrorCode::MissingAccount)?;
                let c = c_outs[j];
                let (expected_pda, bump) = Pubkey::find_program_address(&[b"commitment", c.as_ref()], program_id);
                require_keys_eq!(c_acc_info.key(), expected_pda, ErrorCode::InvalidPda);

                create_pda_account(
                    &ctx.accounts.relayer,
                    c_acc_info,
                    &[b"commitment", c.as_ref(), &[bump]],
                    8,
                    program_id,
                    &ctx.accounts.system_program,
                )?;

                // Update Merkle tree
                last_root = output_roots[j];
                let ptr = pool_state.root_ptr as usize;
                pool_state.root_history[ptr] = last_root;
                pool_state.root_ptr = (pool_state.root_ptr + 1) % 100;
                pool_state.next_idx += 1;

                emit!(NoteCreatedEvent {
                    pool_id: 0,
                    commitment: c,
                });
            }
        }
        pool_state.current_root = last_root;

        // Subtract locked balance and transfer SOL from vault PDA to receiver
        pool_state.locked_balance -= withdraw_amount;

        let vault_seeds = &[
            b"vault",
            pool_state.to_account_info().key.as_ref(),
            &[ctx.bumps.vault],
        ];
        let signer_seeds = &[&vault_seeds[..]];

        let cpi_context = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.receiver.to_account_info(),
            },
            signer_seeds,
        );
        anchor_lang::system_program::transfer(cpi_context, withdraw_amount)?;

        Ok(())
    }
}

// Helper Functions
fn u64_to_be32(val: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..32].copy_from_slice(&val.to_be_bytes());
    out
}

fn u8_to_be32(val: u8) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[31] = val;
    out
}

fn pubkey_to_u256_mod_p(pubkey: &Pubkey) -> [u8; 32] {
    let p_bytes = [
        0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29,
        0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
        0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91,
        0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
    ];
    let p = BigUint::from_bytes_be(&p_bytes);
    let val = BigUint::from_bytes_be(pubkey.as_ref());
    let rem = val % p;
    let rem_bytes = rem.to_bytes_be();
    let mut out = [0u8; 32];
    let len = rem_bytes.len();
    out[32 - len..].copy_from_slice(&rem_bytes);
    out
}

fn verify_tree_roots(
    pool_state: &PoolState,
    enabled: &[u8; 4],
    roots: &[[u8; 32]; 4],
) -> Result<()> {
    for i in 0..4 {
        if enabled[i] == 1 {
            let mut root_exists = false;
            for r in 0..pool_state.root_history.len() {
                if pool_state.root_history[r] == roots[i] {
                    root_exists = true;
                    break;
                }
            }
            require!(root_exists, ErrorCode::InvalidRoot);
        }
    }
    Ok(())
}

fn create_pda_account<'info>(
    payer: &Signer<'info>,
    pda_info: &AccountInfo<'info>,
    seeds: &[&[u8]],
    space: usize,
    program_id: &Pubkey,
    system_program: &Program<'info, System>,
) -> Result<()> {
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(space);
    let ix = anchor_lang::solana_program::system_instruction::create_account(
        payer.key,
        pda_info.key,
        lamports,
        space as u64,
        program_id,
    );
    anchor_lang::solana_program::program::invoke_signed(
        &ix,
        &[
            payer.to_account_info(),
            pda_info.clone(),
            system_program.to_account_info(),
        ],
        &[seeds],
    )?;
    Ok(())
}

// Contexts
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 32 + 32 + 8 + 3204 + 8 + 8 + 32 + 1,
        seeds = [b"pool_state", admin.key().as_ref()],
        bump
    )]
    pub pool_state: Box<Account<'info, PoolState>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetRelayer<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_state", admin.key().as_ref()],
        bump = pool_state.bump,
        has_one = admin
    )]
    pub pool_state: Box<Account<'info, PoolState>>,
}

#[derive(Accounts)]
#[instruction(
    proof_a: [u8; 64],
    proof_b: [u8; 128],
    proof_c: [u8; 64],
    amount: u64,
    c1: [u8; 32],
    c2: [u8; 32]
)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    pub relayer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_state", pool_state.admin.as_ref()],
        bump = pool_state.bump,
        constraint = pool_state.relayer_address == relayer.key() @ ErrorCode::NotRelayer
    )]
    pub pool_state: Box<Account<'info, PoolState>>,

    #[account(
        mut,
        seeds = [b"vault", pool_state.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,

    #[account(
        init,
        payer = user,
        space = 8 + 1,
        seeds = [b"commitment", c1.as_ref()],
        bump
    )]
    pub commitment1: Account<'info, CommitmentAccount>,

    #[account(
        init,
        payer = user,
        space = 8 + 1,
        seeds = [b"commitment", c2.as_ref()],
        bump
    )]
    pub commitment2: Account<'info, CommitmentAccount>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Transfer<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_state", pool_state.admin.as_ref()],
        bump = pool_state.bump,
        constraint = pool_state.relayer_address == relayer.key() @ ErrorCode::NotRelayer
    )]
    pub pool_state: Box<Account<'info, PoolState>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub relayer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_state", pool_state.admin.as_ref()],
        bump = pool_state.bump,
        constraint = pool_state.relayer_address == relayer.key() @ ErrorCode::NotRelayer
    )]
    pub pool_state: Box<Account<'info, PoolState>>,

    #[account(
        mut,
        seeds = [b"vault", pool_state.key().as_ref()],
        bump
    )]
    pub vault: SystemAccount<'info>,

    /// CHECK: Recipient of the withdrawn SOL
    #[account(mut)]
    pub receiver: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

// Account Structures
#[account]
pub struct PoolState {
    pub admin: Pubkey,
    pub relayer_address: Pubkey,
    pub relayer_zk_pubkey: [u8; 32],
    pub locked_balance: u64,
    pub root_history: Vec<[u8; 32]>,
    pub root_ptr: u64,
    pub next_idx: u64,
    pub current_root: [u8; 32],
    pub bump: u8,
}

#[account]
pub struct CommitmentAccount {
    pub bump: u8,
}

// Events
#[event]
pub struct NoteCreatedEvent {
    pub pool_id: u64,
    pub commitment: [u8; 32],
}

#[event]
pub struct NullifierSpentEvent {
    pub nullifier: [u8; 32],
}

// Error Codes
#[error_code]
pub enum ErrorCode {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Invalid commitment provided")]
    InvalidCommitment,
    #[msg("Commitments must be distinct")]
    DuplicateCommitment,
    #[msg("Caller is not the registered relayer")]
    NotRelayer,
    #[msg("ZK proof verification failed")]
    ProofFailed,
    #[msg("Merkle tree root is invalid or expired")]
    InvalidRoot,
    #[msg("Account already exists or is invalid")]
    InvalidPda,
    #[msg("A required account is missing from remaining accounts")]
    MissingAccount,
    #[msg("Insufficient balance in the pool")]
    InsufficientBalance,
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn test_deposit_verification() {
        let proof_a = [0x0a, 0xdb, 0x2f, 0x75, 0x6b, 0xe2, 0x3c, 0xcb, 0x09, 0x77, 0x61, 0x73, 0xa8, 0xee, 0xb4, 0x5a, 0xe2, 0xd9, 0xdb, 0xf3, 0xd9, 0x68, 0xc0, 0x96, 0x5c, 0xb1, 0x4e, 0x40, 0x2d, 0xe5, 0x45, 0x5a, 0x1f, 0xef, 0x6f, 0x07, 0x34, 0x69, 0x97, 0xb7, 0xde, 0x52, 0x5b, 0x8a, 0xb6, 0x2e, 0x2a, 0x30, 0x6c, 0x17, 0xe8, 0xfe, 0xcb, 0xc8, 0x92, 0xdd, 0x22, 0x45, 0x05, 0x5d, 0x40, 0x37, 0x85, 0x75];
        let proof_b = [0x08, 0x19, 0xe3, 0xb7, 0x26, 0x8e, 0xfd, 0xa9, 0xde, 0x51, 0x8c, 0xa5, 0x9d, 0xb0, 0xab, 0xa2, 0x67, 0xc0, 0xfb, 0x8f, 0xc8, 0x84, 0xa0, 0xa5, 0xd5, 0xf1, 0x08, 0xd7, 0x7f, 0x39, 0x5f, 0x7d, 0x08, 0xac, 0xf0, 0x43, 0x24, 0x0d, 0xa9, 0x5d, 0xf3, 0xb7, 0xdd, 0x38, 0x88, 0x46, 0xe8, 0x89, 0xae, 0x7c, 0x72, 0x3f, 0x53, 0x94, 0xb7, 0x45, 0x7a, 0x28, 0xeb, 0x4c, 0xf8, 0xfb, 0x32, 0xda, 0x05, 0x2e, 0xe9, 0x0a, 0x8d, 0xd3, 0x17, 0xc1, 0x1e, 0x1d, 0x57, 0x84, 0xc3, 0x47, 0x89, 0x95, 0x26, 0x37, 0x15, 0xe9, 0x19, 0x68, 0xca, 0xe6, 0x60, 0x96, 0x37, 0x20, 0x94, 0xb7, 0x48, 0x1e, 0x20, 0x95, 0xaa, 0xb9, 0x67, 0x18, 0x77, 0x30, 0x55, 0x2c, 0x1b, 0x83, 0x1c, 0x53, 0x65, 0x2b, 0xbf, 0x1b, 0xd2, 0xa2, 0xc9, 0x7c, 0x23, 0x72, 0xfc, 0x67, 0x0d, 0x90, 0xe6, 0x83, 0xcb, 0xfb];
        let proof_c = [0x29, 0xd4, 0xcd, 0x4e, 0xa7, 0x99, 0x39, 0x1b, 0x6e, 0x27, 0xab, 0xb7, 0x4c, 0x12, 0xa5, 0x88, 0x9e, 0x0a, 0x24, 0x53, 0xe2, 0xf8, 0x7d, 0x27, 0x9c, 0x86, 0x58, 0x16, 0xf4, 0xf8, 0x6c, 0xed, 0x13, 0xb4, 0xb1, 0x23, 0x24, 0x49, 0x74, 0x59, 0xdd, 0xe2, 0xd5, 0x2a, 0xab, 0xc0, 0x67, 0x4b, 0x48, 0x92, 0xbc, 0xe1, 0x0c, 0xc7, 0x72, 0xf0, 0x34, 0xe5, 0x9c, 0x70, 0x55, 0xad, 0x8f, 0xaf];
        let public_inputs: [[u8; 32]; 4] = [
            [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3b, 0x9a, 0xca, 0x00],
            [0x00, 0x57, 0x52, 0x35, 0x3d, 0xf1, 0xaa, 0x82, 0xb9, 0xdb, 0x26, 0x60, 0x52, 0x2a, 0x44, 0xf7, 0x00, 0x79, 0x7f, 0xad, 0x9f, 0x7a, 0x8c, 0x32, 0xa9, 0xf9, 0xc7, 0xdf, 0x63, 0x0a, 0xe5, 0x30],
            [0x12, 0xee, 0x59, 0x10, 0x35, 0xd2, 0xe2, 0x2d, 0x20, 0x3e, 0x23, 0x42, 0xb7, 0xe4, 0x92, 0xae, 0xe0, 0x88, 0x84, 0x6d, 0x3c, 0x53, 0x0e, 0x6b, 0x78, 0x7b, 0x3d, 0xf4, 0x9f, 0x31, 0x53, 0xd3],
            [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1a, 0x7f, 0x61, 0x92],
        ];

        let mut verifier = Groth16Verifier::new(
            &proof_a,
            &proof_b,
            &proof_c,
            &public_inputs,
            &DEPOSIT_VK,
        ).expect("Failed to initialize verifier");

        let res = verifier.verify();
        println!("Verifier verify result: {:?}", res);
        assert!(res.is_ok(), "Verification failed");
    }

    #[test]
    fn test_arkworks_pairing() {
        use ark_bn254::{Bn254, G1Affine, G2Affine};
        use ark_ec::pairing::Pairing;
        use ark_ec::{AffineRepr, CurveGroup};
        use ark_serialize::{CanonicalDeserialize, Compress, Validate};
        use ark_ff::One;
        use std::ops::{Neg, Mul};

        fn change_endianness(bytes: &[u8]) -> Vec<u8> {
            let mut vec = Vec::new();
            for b in bytes.chunks(32) {
                for byte in b.iter().rev() {
                    vec.push(*byte);
                }
            }
            vec
        }

        fn to_g1(be_bytes: &[u8; 64]) -> G1Affine {
            let le_bytes = change_endianness(be_bytes);
            G1Affine::deserialize_with_mode(
                &*[&le_bytes[..], &[0u8][..]].concat(),
                Compress::No,
                Validate::Yes,
            ).unwrap()
        }

        fn to_g2(be_bytes: &[u8; 128]) -> G2Affine {
            let mut swapped = [0u8; 128];
            swapped[0..32].copy_from_slice(&be_bytes[32..64]);
            swapped[32..64].copy_from_slice(&be_bytes[0..32]);
            swapped[64..96].copy_from_slice(&be_bytes[96..128]);
            swapped[96..128].copy_from_slice(&be_bytes[64..96]);
            let le_bytes_swapped = change_endianness(&swapped);
            G2Affine::deserialize_with_mode(&le_bytes_swapped[..], Compress::No, Validate::Yes).unwrap()
        }

        let proof_a_non_negated = [0x0a, 0xdb, 0x2f, 0x75, 0x6b, 0xe2, 0x3c, 0xcb, 0x09, 0x77, 0x61, 0x73, 0xa8, 0xee, 0xb4, 0x5a, 0xe2, 0xd9, 0xdb, 0xf3, 0xd9, 0x68, 0xc0, 0x96, 0x5c, 0xb1, 0x4e, 0x40, 0x2d, 0xe5, 0x45, 0x5a, 0x10, 0x74, 0xdf, 0x6b, 0xac, 0xc8, 0x08, 0x71, 0xd9, 0xfd, 0xea, 0x2b, 0xcb, 0x53, 0x2e, 0x2d, 0x2b, 0x69, 0x81, 0x92, 0x9c, 0xa9, 0x37, 0xb0, 0x19, 0xdb, 0x86, 0xb9, 0x98, 0x45, 0x77, 0xd2];
        let proof_b = [0x08, 0x19, 0xe3, 0xb7, 0x26, 0x8e, 0xfd, 0xa9, 0xde, 0x51, 0x8c, 0xa5, 0x9d, 0xb0, 0xab, 0xa2, 0x67, 0xc0, 0xfb, 0x8f, 0xc8, 0x84, 0xa0, 0xa5, 0xd5, 0xf1, 0x08, 0xd7, 0x7f, 0x39, 0x5f, 0x7d, 0x08, 0xac, 0xf0, 0x43, 0x24, 0x0d, 0xa9, 0x5d, 0xf3, 0xb7, 0xdd, 0x38, 0x88, 0x46, 0xe8, 0x89, 0xae, 0x7c, 0x72, 0x3f, 0x53, 0x94, 0xb7, 0x45, 0x7a, 0x28, 0xeb, 0x4c, 0xf8, 0xfb, 0x32, 0xda, 0x05, 0x2e, 0xe9, 0x0a, 0x8d, 0xd3, 0x17, 0xc1, 0x1e, 0x1d, 0x57, 0x84, 0xc3, 0x47, 0x89, 0x95, 0x26, 0x37, 0x15, 0xe9, 0x19, 0x68, 0xca, 0xe6, 0x60, 0x96, 0x37, 0x20, 0x94, 0xb7, 0x48, 0x1e, 0x20, 0x95, 0xaa, 0xb9, 0x67, 0x18, 0x77, 0x30, 0x55, 0x2c, 0x1b, 0x83, 0x1c, 0x53, 0x65, 0x2b, 0xbf, 0x1b, 0xd2, 0xa2, 0xc9, 0x7c, 0x23, 0x72, 0xfc, 0x67, 0x0d, 0x90, 0xe6, 0x83, 0xcb, 0xfb];
        let proof_c = [0x29, 0xd4, 0xcd, 0x4e, 0xa7, 0x99, 0x39, 0x1b, 0x6e, 0x27, 0xab, 0xb7, 0x4c, 0x12, 0xa5, 0x88, 0x9e, 0x0a, 0x24, 0x53, 0xe2, 0xf8, 0x7d, 0x27, 0x9c, 0x86, 0x58, 0x16, 0xf4, 0xf8, 0x6c, 0xed, 0x13, 0xb4, 0xb1, 0x23, 0x24, 0x49, 0x74, 0x59, 0xdd, 0xe2, 0xd5, 0x2a, 0xab, 0xc0, 0x67, 0x4b, 0x48, 0x92, 0xbc, 0xe1, 0x0c, 0xc7, 0x72, 0xf0, 0x34, 0xe5, 0x9c, 0x70, 0x55, 0xad, 0x8f, 0xaf];
        let public_inputs: [[u8; 32]; 4] = [
            [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x3b, 0x9a, 0xca, 0x00],
            [0x00, 0x57, 0x52, 0x35, 0x3d, 0xf1, 0xaa, 0x82, 0xb9, 0xdb, 0x26, 0x60, 0x52, 0x2a, 0x44, 0xf7, 0x00, 0x79, 0x7f, 0xad, 0x9f, 0x7a, 0x8c, 0x32, 0xa9, 0xf9, 0xc7, 0xdf, 0x63, 0x0a, 0xe5, 0x30],
            [0x12, 0xee, 0x59, 0x10, 0x35, 0xd2, 0xe2, 0x2d, 0x20, 0x3e, 0x23, 0x42, 0xb7, 0xe4, 0x92, 0xae, 0xe0, 0x88, 0x84, 0x6d, 0x3c, 0x53, 0x0e, 0x6b, 0x78, 0x7b, 0x3d, 0xf4, 0x9f, 0x31, 0x53, 0xd3],
            [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1a, 0x7f, 0x61, 0x92],
        ];

        let g1_a = to_g1(&proof_a_non_negated);
        let g2_b = to_g2(&proof_b);
        let g1_c = to_g1(&proof_c);

        let vk_alpha_g1 = to_g1(&DEPOSIT_VK.vk_alpha_g1);
        let vk_beta_g2 = to_g2(&DEPOSIT_VK.vk_beta_g2);
        let vk_gamma_g2 = to_g2(&DEPOSIT_VK.vk_gamme_g2);
        let vk_delta_g2 = to_g2(&DEPOSIT_VK.vk_delta_g2);

        // Prepare public inputs point
        let mut prepared_public_inputs = to_g1(&DEPOSIT_VK.vk_ic[0]).into_group();
        for (i, input) in public_inputs.iter().enumerate() {
            let input_val = num_bigint::BigUint::from_bytes_be(input);
            let scalar = <ark_bn254::Fr as ark_ff::PrimeField>::from_be_bytes_mod_order(&input_val.to_bytes_be());
            let ic_point = to_g1(&DEPOSIT_VK.vk_ic[i + 1]);
            let mul_res = ic_point.mul(scalar);
            prepared_public_inputs = prepared_public_inputs + mul_res;
        }
        let prepared_public_inputs = prepared_public_inputs.into_affine();

        // e(A, B) == e(alpha, beta) * e(IC, gamma) * e(C, delta)
        // Which is: e(A, B) * e(IC, -gamma) * e(C, -delta) * e(alpha, -beta) == 1
        let pairing_res = Bn254::multi_pairing(
            [g1_a, prepared_public_inputs, g1_c, vk_alpha_g1],
            [g2_b, vk_gamma_g2.neg(), vk_delta_g2.neg(), vk_beta_g2.neg()]
        );
        let is_ok = pairing_res.0.is_one();
        println!("Pairing equation satisfies: {}", is_ok);
        assert!(is_ok, "Off-chain pairing check failed");
    }
}

