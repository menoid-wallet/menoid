use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;
use num_bigint::BigUint;
use solana_poseidon::{hashv, Endianness, Parameters};

pub mod verifying_keys;
use verifying_keys::{DEPOSIT_VK, TRANSFER_VK, WITHDRAW_VK};

declare_id!("3wxDTqw42qqftiAcTZ6kLeNtepuSmB1mR1skrEcwD9SC");

// ── Merkle tree parameters (must match the Ethereum poolLib.sol + circom MerklePath) ──
/// Tree depth — 20 levels, so each pool holds up to 2^20 leaves.
pub const TREE_DEPTH: usize = 20;
/// Circular root-history length. A root stays "known" for this many inserts.
pub const ROOT_HISTORY_SIZE: u64 = 100;
/// Maximum number of leaves in a single tree (2^TREE_DEPTH).
pub const MAX_LEAF: u64 = 1u64 << TREE_DEPTH;

/// Root of an empty depth-20 tree (Z20) under circomlib Poseidon with zero leaves.
/// Recomputed on-chain in `initialize` and asserted against this constant so that any
/// mismatch between the on-chain sol_poseidon syscall and the off-chain circomlibjs
/// hash is caught immediately at init time instead of surfacing later as InvalidRoot.
pub const EMPTY_ROOT: [u8; 32] = [
    0x21, 0x34, 0xe7, 0x6a, 0xc5, 0xd2, 0x1a, 0xab, 0x18, 0x6c, 0x2b, 0xe1, 0xdd, 0x8f, 0x84, 0xee,
    0x88, 0x0a, 0x1e, 0x46, 0xea, 0xf7, 0x12, 0xf9, 0xd3, 0x71, 0xb6, 0xdf, 0x22, 0x19, 0x1f, 0x3e
];

#[program]
pub mod noid_solana {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        relayer_commitment: [u8; 32],
        relayer_address: Pubkey,
    ) -> Result<()> {
        let pool_state = &mut ctx.accounts.pool_state;
        pool_state.admin = ctx.accounts.admin.key();
        pool_state.relayer_address = relayer_address;
        pool_state.relayer_commitment = relayer_commitment;
        pool_state.locked_balance = 0;

        // Build the empty-tree zero hashes and seed the filled-subtree cache, exactly like
        // poolLib.createPool on Ethereum:
        //   zeros[0] = 0, zeros[i] = Poseidon(zeros[i-1], zeros[i-1]), empty root = Z20.
        let mut zero = [0u8; 32];
        for i in 0..TREE_DEPTH {
            pool_state.zeros[i] = zero;
            pool_state.filled_subtrees[i] = zero;
            zero = poseidon_hash2(&zero, &zero)?;
        }
        let empty_root = zero; // Z20

        // Fail fast if the on-chain syscall disagrees with the expected off-chain hash.
        require!(empty_root == EMPTY_ROOT, ErrorCode::PoseidonMismatch);

        pool_state.root_history = vec![empty_root; ROOT_HISTORY_SIZE as usize];
        pool_state.root_ptr = 0;
        pool_state.next_idx = 0;
        pool_state.current_root = empty_root;
        pool_state.bump = ctx.bumps.pool_state;
        Ok(())
    }

    pub fn set_relayer(
        ctx: Context<SetRelayer>,
        relayer_commitment: [u8; 32],
        relayer_address: Pubkey,
    ) -> Result<()> {
        let pool_state = &mut ctx.accounts.pool_state;
        pool_state.relayer_commitment = relayer_commitment;
        pool_state.relayer_address = relayer_address;
        Ok(())
    }

    /// One-time binding of a real wallet address to its private identity.
    ///
    /// Wallet responsibilities (off-chain):
    /// - Sign the message "menoid_Wallet" with the real wallet's private key
    /// - Derive the BabyJubJub spending keypair from that signature
    /// - Derive the ed25519 encryption keypair from the same signature
    /// - user_commitment = Poseidon(walletAddress mod p, spendPk.x, spendPk.y)
    ///
    /// `encryption_public_key` is stored here on purpose. A sender needs BOTH
    /// the receiver's commitment (to lock the note) and this key (to encrypt
    /// it), and the key cannot be recovered from the commitment hash. Kept
    /// off-chain, a lookup miss is indistinguishable from "never registered" —
    /// and a wallet that reads that as "send in the clear" is the one failure
    /// a privacy wallet must not have.
    ///
    /// Registering twice fails: the registration PDA already exists.
    pub fn register(
        ctx: Context<Register>,
        user_commitment: [u8; 32],
        encryption_public_key: [u8; 32],
    ) -> Result<()> {
        require!(user_commitment != [0u8; 32], ErrorCode::InvalidUserCommitment);
        require!(
            encryption_public_key != [0u8; 32],
            ErrorCode::InvalidEncryptionKey
        );

        let registration = &mut ctx.accounts.registration;
        registration.wallet = ctx.accounts.user.key();
        registration.user_commitment = user_commitment;
        registration.encryption_public_key = encryption_public_key;
        registration.bump = ctx.bumps.registration;

        emit!(WalletRegisteredEvent {
            wallet: ctx.accounts.user.key(),
            user_commitment,
            encryption_public_key,
        });

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
    ) -> Result<()> {
        require!(amount > 0, ErrorCode::ZeroAmount);
        require!(c1 != [0u8; 32], ErrorCode::InvalidCommitment);

        // C2 is the optional relayer fee note - it may be zero
        let c2_enabled: u64 = if c2 != [0u8; 32] { 1 } else { 0 };
        if c2_enabled == 1 {
            require!(c1 != c2, ErrorCode::DuplicateCommitment);
            require!(ctx.accounts.commitment2.is_some(), ErrorCode::MissingAccount);
        }

        // Prepare public inputs:
        // [amount, c1, c2, c2_enabled, relayer_commitment (relayer user commitment)]
        let amount_be = u64_to_be32(amount);
        let public_inputs: [[u8; 32]; 5] = [
            amount_be,
            c1,
            c2,
            u64_to_be32(c2_enabled),
            ctx.accounts.pool_state.relayer_commitment,
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

        // Insert the commitment(s) and recompute the Merkle root on-chain via the
        // filled-subtree algorithm (no caller-supplied roots). One root — the state
        // after all leaves — is appended to the history for this batch.
        pool_state.insert_leaf(c1)?;
        emit!(NoteCreatedEvent {
            pool_id: 0,
            commitment: c1,
        });
        if c2_enabled == 1 {
            pool_state.insert_leaf(c2)?;
            emit!(NoteCreatedEvent {
                pool_id: 0,
                commitment: c2,
            });
        }
        pool_state.push_root();

        // The commitment PDAs are initialized by the Anchor framework automatically
        ctx.accounts.commitment1.bump = ctx.bumps.commitment1;
        if let Some(commitment2) = ctx.accounts.commitment2.as_mut() {
            commitment2.bump = ctx.bumps.commitment2.unwrap_or_default();
        }

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
    ) -> Result<()> {
        let pool_state = &mut ctx.accounts.pool_state;

        // Verify inputs
        verify_tree_roots(pool_state, &enabled, &roots)?;

        // Prepare public inputs
        let mut public_inputs: [[u8; 32]; 19] = [[0u8; 32]; 19];
        public_inputs[0] = pool_state.relayer_commitment;
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
                    &ctx.accounts.payer,
                    null_acc_info,
                    &[b"nullifier", n.as_ref(), &[bump]],
                    8,
                    program_id,
                    &ctx.accounts.system_program,
                )?;
                emit!(NullifierSpentEvent { nullifier: n });
            }
        }

        // Insert new commitments, recomputing the Merkle root on-chain per leaf.
        let mut inserted_any = false;
        for j in 0..3 {
            if output_enabled[j] == 1 {
                let c_acc_info = remaining_accounts_iter.next().ok_or(ErrorCode::MissingAccount)?;
                let c = c_outs[j];
                let (expected_pda, bump) = Pubkey::find_program_address(&[b"commitment", c.as_ref()], program_id);
                require_keys_eq!(c_acc_info.key(), expected_pda, ErrorCode::InvalidPda);

                create_pda_account(
                    &ctx.accounts.payer,
                    c_acc_info,
                    &[b"commitment", c.as_ref(), &[bump]],
                    8,
                    program_id,
                    &ctx.accounts.system_program,
                )?;

                // Update Merkle tree (filled-subtree root computation, no caller roots)
                pool_state.insert_leaf(c)?;
                inserted_any = true;

                emit!(NoteCreatedEvent {
                    pool_id: 0,
                    commitment: c,
                });
            }
        }
        // Append a single root for this batch once all outputs are inserted.
        if inserted_any {
            pool_state.push_root();
        }

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
        public_inputs[1] = pool_state.relayer_commitment;
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
                    &ctx.accounts.payer,
                    null_acc_info,
                    &[b"nullifier", n.as_ref(), &[bump]],
                    8,
                    program_id,
                    &ctx.accounts.system_program,
                )?;
                emit!(NullifierSpentEvent { nullifier: n });
            }
        }

        // Insert new commitments (change outputs), recomputing the root on-chain per leaf.
        let mut inserted_any = false;
        for j in 0..2 {
            if out_enabled[j] == 1 {
                let c_acc_info = remaining_accounts_iter.next().ok_or(ErrorCode::MissingAccount)?;
                let c = c_outs[j];
                let (expected_pda, bump) = Pubkey::find_program_address(&[b"commitment", c.as_ref()], program_id);
                require_keys_eq!(c_acc_info.key(), expected_pda, ErrorCode::InvalidPda);

                create_pda_account(
                    &ctx.accounts.payer,
                    c_acc_info,
                    &[b"commitment", c.as_ref(), &[bump]],
                    8,
                    program_id,
                    &ctx.accounts.system_program,
                )?;

                // Update Merkle tree (filled-subtree root computation, no caller roots)
                pool_state.insert_leaf(c)?;
                inserted_any = true;

                emit!(NoteCreatedEvent {
                    pool_id: 0,
                    commitment: c,
                });
            }
        }
        // Append a single root for this batch if any change output was inserted.
        if inserted_any {
            pool_state.push_root();
        }

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

/// Poseidon(2) over BN254 using the native `sol_poseidon` syscall.
/// `Bn254X5` + `BigEndian` make this byte-for-byte compatible with circomlib's
/// `Poseidon(2)` (the hash used in `merkle_path.circom` and by circomlibjs off-chain).
fn poseidon_hash2(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32]> {
    let h = hashv(
        Parameters::Bn254X5,
        Endianness::BigEndian,
        &[&left[..], &right[..]],
    )
    .map_err(|_| error!(ErrorCode::PoseidonError))?;
    Ok(h.to_bytes())
}

impl PoolState {
    /// Insert a single leaf and recompute `current_root` using the incremental
    /// filled-subtree algorithm — the exact port of poolLib.updatePool on Ethereum.
    /// Walks all TREE_DEPTH levels, hashing each node with the native Poseidon syscall.
    /// Does NOT append to the root history (callers batch that via `push_root`).
    fn insert_leaf(&mut self, commitment: [u8; 32]) -> Result<()> {
        require!(self.next_idx < MAX_LEAF, ErrorCode::TreeFull);
        let mut current = commitment;
        let mut idx = self.next_idx;
        for i in 0..TREE_DEPTH {
            if idx & 1 == 0 {
                // Even index: `current` becomes the left child waiting for a right sibling.
                self.filled_subtrees[i] = current;
                current = poseidon_hash2(&current, &self.zeros[i])?;
            } else {
                // Odd index: the stored left subtree is the sibling.
                current = poseidon_hash2(&self.filled_subtrees[i], &current)?;
            }
            idx >>= 1;
        }
        self.current_root = current;
        self.next_idx += 1;
        Ok(())
    }

    /// Append the current root to the circular root history.
    fn push_root(&mut self) {
        let ptr = self.root_ptr as usize;
        self.root_history[ptr] = self.current_root;
        self.root_ptr = (self.root_ptr + 1) % ROOT_HISTORY_SIZE;
    }
}

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
        // disc + admin + relayer_addr + relayer_zk + locked + root_history(4+100*32)
        //  + root_ptr + next_idx + current_root + filled_subtrees(20*32) + zeros(20*32) + bump
        space = 8 + 32 + 32 + 32 + 8 + 3204 + 8 + 8 + 32 + 640 + 640 + 1,
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
pub struct Register<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    // init fails if the wallet is already registered (PDA already exists)
    //
    // Seed is "registration_v2": v1 accounts were laid out without the
    // encryption key and are 32 bytes too small to deserialize as the current
    // Registration, so they get their own address space rather than colliding.
    #[account(
        init,
        payer = user,
        space = 8 + 32 + 32 + 32 + 1,
        seeds = [b"registration_v2", user.key().as_ref()],
        bump
    )]
    pub registration: Account<'info, Registration>,

    pub system_program: Program<'info, System>,
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

    // No relayer/co-signer required: anyone can submit a deposit. Correctness of the
    // new Merkle root is enforced on-chain (filled-subtree recomputation), and the
    // deposit ZK proof binds the relayer fee note via relayer_commitment.
    #[account(
        mut,
        seeds = [b"pool_state", pool_state.admin.as_ref()],
        bump = pool_state.bump
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

    // Optional: only present when C2 (relayer fee note) is non-zero
    #[account(
        init,
        payer = user,
        space = 8 + 1,
        seeds = [b"commitment", c2.as_ref()],
        bump
    )]
    pub commitment2: Option<Account<'info, CommitmentAccount>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Transfer<'info> {
    // Any signer may submit a transfer and pay rent for the new PDAs (permissionless).
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_state", pool_state.admin.as_ref()],
        bump = pool_state.bump
    )]
    pub pool_state: Box<Account<'info, PoolState>>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    // Any signer may submit a withdraw and pay rent for the new PDAs (permissionless).
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [b"pool_state", pool_state.admin.as_ref()],
        bump = pool_state.bump
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
    pub relayer_commitment: [u8; 32],
    pub locked_balance: u64,
    pub root_history: Vec<[u8; 32]>,
    pub root_ptr: u64,
    pub next_idx: u64,
    pub current_root: [u8; 32],
    /// Latest completed left-subtree hash at each level (incremental Merkle tree cache).
    pub filled_subtrees: [[u8; 32]; 20],
    /// Zero-subtree hash at each level (Z0..Z19); seeded once in `initialize`.
    pub zeros: [[u8; 32]; 20],
    pub bump: u8,
}

#[account]
pub struct CommitmentAccount {
    pub bump: u8,
}

/// wallet address => private identity.
///
/// Holds everything a sender needs to send this wallet a private note:
/// the user commitment (Poseidon(address mod p, spendPk.x, spendPk.y)) and the
/// ed25519 note-encryption public key.
#[account]
pub struct Registration {
    pub wallet: Pubkey,
    pub user_commitment: [u8; 32],
    pub encryption_public_key: [u8; 32],
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

#[event]
pub struct WalletRegisteredEvent {
    pub wallet: Pubkey,
    pub user_commitment: [u8; 32],
    pub encryption_public_key: [u8; 32],
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
    #[msg("Invalid encryption public key provided")]
    InvalidEncryptionKey,
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
    #[msg("Merkle tree is full")]
    TreeFull,
    #[msg("Poseidon hashing failed")]
    PoseidonError,
    #[msg("On-chain Poseidon does not match expected empty root")]
    PoseidonMismatch,
    #[msg("Invalid user commitment")]
    InvalidUserCommitment,
}
