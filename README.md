# 🌑 Menoid — Protocol

> The zero-knowledge privacy pool behind [Menoid](https://menoid.xyz), a private
> crypto wallet for the multi-chain world.

This repository holds the **circuits and on-chain contracts**. The wallets that
use them live in their own repositories — see [Where everything lives](#-where-everything-lives).

---

## ✨ What this is

Menoid lets you keep your own wallet address and still move funds without
publishing who paid whom, or how much.

Funds enter a **shielded pool** as commitments. Ownership is proved with a
zero-knowledge proof rather than a signature, so a transfer reveals nothing but
the fact that *some* valid, unspent note changed hands. Balances, senders,
receivers and amounts stay hidden. The same protocol is deployed on six
networks, so the privacy model does not change when you change chains.

There is **one address per user**. Open Mode (public) and Noid Mode (private)
are two views of the same wallet — no second address, no second seed phrase.

---

## 🧩 How it works

### One-time registration

The real wallet signs one readable message. Every key is derived from that
signature, so there is nothing extra to store or back up:

```
signature      = sign("Menoid v1-mainnet: create my private account keys. … Key index: 0")
seed           = keccak("menoid/v1m/seed" ‖ signature)        // never stored, never sent

sk             = keccak("menoid/v1m/spend" ‖ seed) mod l       // spending key (BabyJubJub)
nk             = Poseidon(2, sk)                               // nullifier key
ivk, ovk       = derived from seed, per viewing epoch          // incoming / outgoing viewing keys
userCommitment = Poseidon(1, address, spendPk.x, spendPk.y)

register(userCommitment, ivkPub)                               // on-chain, once per chain
```

A sender resolves a recipient straight from the chain with one call,
`registrationOf(address)`: the user commitment to lock the note to, and the
viewing public key to encrypt it to. The message has no chain id, so the same
identity works on every chain.

Keys can change later, only from the registered wallet: `updateViewingKey`
moves to a new viewing key with the same identity, and `rotateKeys` moves to a
new identity if the signature ever leaks.

### Notes, commitments, nullifiers

```
npk        = Poseidon(3, userCommitment, r)     // note public key: hides the owner
commitment = Poseidon(4, token, amount, npk)    // a note; the token is inside it
nullifier  = Poseidon(5, nk, commitment, r)     // published when the note is spent
```

Every token shares **one pool and one Merkle tree**. The token is a private
field inside the commitment, so a transfer does not reveal which token moved.
A nullifier is revealed only when a note is spent: it prevents double-spends
without revealing *which* note was spent. Each note is emitted encrypted to its
owner's viewing key, and only that key can open it. The leading numbers are
domain separators, so no hash can be mistaken for another.

### Viewing keys

Nullifiers use `nk` instead of the spending key, so a user can show their
activity without giving anyone the power to spend:

| You share | They see | Can spend |
|---|---|---|
| Incoming viewing key | notes you received | ❌ |
| Full viewing key (`ivk` + `nk` + `ovk`) | received, spent, and who you paid | ❌ |
| Epoch viewing key | the same, for one period only | ❌ |
| Payment receipt | one payment, no key at all | ❌ |

### Operations

| Operation | What it does | Proof |
|---|---|---|
| **Deposit** | Public tokens → one private note. The contract computes the commitment itself | none |
| **Transfer** | Private notes → private notes. Token, amounts, sender and receiver stay hidden | `transfer_proof` |
| **Withdraw** | Private notes → public tokens at any address | `withdraw_proof` |
| **Swap** 🚧 | Private notes of one token → a private note of another; the pool executes the trade | `withdraw_proof` |

- **Fixed shape.** Every spend publishes 4 nullifiers and creates 3 (transfer)
  or 2 (withdraw) notes. Dummy notes fill the unused slots, so nobody learns
  how many notes were really spent.
- **Bound data.** Encrypted notes, the withdraw recipient and the swap
  parameters are hashed into the proof (`extDataHash`). Changing any of them
  makes the proof fail.
- **128-bit amounts** in every circuit, so no balance equation can wrap around
  the BN254 field.
- **Native coins** are wrapped on deposit (MON → WMON) and can be unwrapped on
  withdraw.

A **relayer** submits transfers, withdrawals and swaps, so a user never pays
gas from the address they are trying to keep private. It is paid with the last
output note of the same proof, in the same token. The relayer can refuse a
transaction, but it cannot steal, redirect, forge or deanonymise.

### Swaps 🚧

The next piece being built on this branch. One pool holds every token, so the
pool itself calls the swap; there is no separate pool per token.

```
1. quote    tokenIn, amountIn → tokenOut, minOut, route (DEX path), deadline
2. prove    withdraw circuit: tokenIn notes leave the private balance
                publicToken = tokenIn, publicAmount = amountIn
            npkOut = Poseidon(3, userCommitment, rOut)      // owner of the output, amount not known yet
            tokenOut, minOut, npkOut, route, deadline → extDataHash
3. pool     verify → spend nullifiers → amountIn to the swap adapter → DEX
            out = balance after − balance before;  require out ≥ minOut
            commitment = Poseidon(4, tokenOut, out, npkOut) // the pool finishes the note
4. wallet   decrypts rOut, reads `out` from the event, owns the new note
```

On-chain, a swap shows the token pair and both amounts, never who swapped or
where the output goes. If the price moves past `minOut` or the deadline passes,
the whole transaction reverts and the input notes stay unspent.

---

## 📁 Repository layout

```
.
├── evms/          Solidity + Hardhat  — Monad, Ethereum Sepolia, Base Sepolia
│   ├── contracts/     NoidPool, the three Groth16 verifiers, Poseidon wrapper
│   ├── circuits/      Circom sources
│   ├── test/          11 end-to-end tests against a local chain
│   └── scripts/       deploy.js
├── aptos/         Move — Aptos testnet
│   ├── sources/       pool, verifier, merkle_tree, poseidon
│   ├── circuits/      Circom sources (incl. new_root, Aptos-only)
│   └── zk_build/      compiled circuits + verifying keys (shared with Solana)
├── noid_sui/      Move — Sui testnet
│   └── sources/       pool, verifier, merkle_tree, poseidon
├── noid_solana/   Rust + Anchor — Solana devnet
│   └── programs/      noid_solana (verifying keys compiled in)
├── DOCS.md        the full V1 protocol documentation
└── deploy.txt     every deployed address, and the record of each rollout
```

Four codebases, one protocol. The circuits are the same on every chain; what
differs is how each chain verifies a Groth16 proof and stores a Merkle forest.

### Aptos is the exception

Aptos cannot verify a Merkle insertion on-chain within its gas limits, so it
carries a **fourth circuit** (`new_root`) and a two-step flow: deposit /
transfer / withdraw *queue* a commitment, and `pool::update_root` is then called
once per pending commitment with a proof that the new root follows correctly
from the old one. The pool refuses new operations while anything is queued.
Every other chain inserts into the tree inline. This is written up in full in
[DOCS.md → Exception — Aptos](DOCS.md#exception--aptos-updates-the-tree-in-a-second-step).

---

## ⚙️ Tech

**Zero knowledge** — Circom 2, Groth16, snarkjs, Poseidon (BN254), BabyJubJub
**Contracts** — Solidity 0.8.20 / Hardhat · Move (Aptos + Sui) · Rust / Anchor
**Chains** — Monad, Ethereum Sepolia, Base Sepolia, Solana, Sui, Aptos

---

## 🌐 Deployments

All six are on testnet. Addresses, deploy blocks, RPC caveats and the history of
every rollout are in **[deploy.txt](deploy.txt)**.

| Chain | Network |
|---|---|
| Monad | testnet (10143) |
| Ethereum Sepolia | testnet (11155111) |
| Base Sepolia | testnet (84532) |
| Solana | devnet |
| Sui | testnet |
| Aptos | testnet |

---

## 🚀 Working on it

```bash
# EVM — compile, run a local chain, deploy, test
cd evms
npx hardhat compile
npx hardhat node                                   # in another shell
npx hardhat run scripts/deploy.js --network localhost
npx hardhat test test/noidpool-test.js --network localhost

# EVM — testnet
npx hardhat run scripts/deploy.js --network monad   # | sepolia | baseSepolia

# Aptos
cd aptos && aptos move compile --named-addresses noid=<module_addr>
npx ts-node scripts/deploy_testnet.ts

# Sui
cd noid_sui && sui move build && sui client publish --gas-budget 500000000
npx ts-node scripts/deploy.ts

# Solana
cd noid_solana && anchor build
npx ts-node scripts/deploy_initialize.ts
```

Each chain directory keeps its own `.env` (deployer key, RPC, deployed ids).
None of them is committed.

> **Solana build note** — the Solana toolchain ships rustc 1.84, which cannot
> parse `edition2024` manifests. Four crates are pinned back in `Cargo.lock`;
> see *BUILD PINS* in [deploy.txt](deploy.txt) before touching dependencies.

---

## 📖 Documentation

The full protocol write-up — registration, deposit, transfer and withdraw, each
with its own diagram — lives in **[DOCS.md](DOCS.md)**, and is also published as
its own repository:

### 👉 **[menoid-wallet/Docs](https://github.com/menoid-wallet/Docs)**

| Section | What it covers |
|---|---|
| [What is Menoid](DOCS.md#what-is-menoid) | Why privacy matters, Open Mode vs Noid Mode, roadmap |
| [Core Vocabulary](DOCS.md#core-vocabulary) | Notes, commitments, nullifiers, relayers |
| [1. Noid Mode Registration](DOCS.md#1-noid-mode-registration) | One signature → your Noid identity, registered on-chain |
| [2. Overview](DOCS.md#2-overview) | One pool, three operations, and the relayer |
| [3. Deposit](DOCS.md#3-deposit) | Open Mode → Noid Mode |
| [4. Transfer](DOCS.md#4-transfer) | Private value movement |
| [5. Withdraw](DOCS.md#5-withdraw) | Noid Mode → Open Mode |

---

## 🔗 Where everything lives

This repository is the protocol only. **The demos are in the wallet repos:**

| Repository | What it is |
|---|---|
| 🧩 **[menoid-wallet/Wallet](https://github.com/menoid-wallet/Wallet)** | The browser extension and the relayer backend — **step-by-step demo here** |
| 📱 **[menoid-wallet/wallet-android](https://github.com/menoid-wallet/wallet-android)** | The Android app — **step-by-step demo here** |
| 📖 **[menoid-wallet/Docs](https://github.com/menoid-wallet/Docs)** | The protocol documentation |
| 🌐 **[menoid-wallet/website](https://github.com/menoid-wallet/website)** | [menoid.xyz](https://menoid.xyz) |

---

## ⚠️ Status

Testnet. Unaudited. The circuits have not been through a trusted setup ceremony
with independent participants — the current `.zkey` files come from a local
setup and are suitable for testnet only. Do not put real funds anywhere near
this.

---

**Menoid — A Private Crypto Wallet.**

[menoid.xyz](https://menoid.xyz)
