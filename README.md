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

A wallet binds itself to a private identity once, per chain:

```
signature   = sign("menoid_Wallet")                     // the real wallet signs
spendKey    = BabyJubJub keypair  derived from signature
encKey      = encryption keypair  derived from signature
userCommitment = Poseidon(address mod p, spendPk.x, spendPk.y)

register(userCommitment, encryptionPublicKey)           // on-chain, once
```

Both halves live **on-chain**. A sender needs the commitment to lock a note to
you and the encryption key to encrypt it, and the second cannot be derived from
the first — so both are registered together and anyone can resolve a recipient
straight from the chain, with no server in the path.

### Notes, commitments, nullifiers

```
commitment = Poseidon(1, amount, r, userCommitment)     // a note you own
nullifier  = Poseidon(2, commitment, r, spendSecretKey) // published when spent
```

Commitments are inserted into an incremental Merkle forest. A nullifier is
revealed only when a note is spent, which prevents double-spends without
revealing *which* note was spent. The encrypted note itself is emitted as an
event — only the receiver's encryption key can open it.

### Three operations

| Operation | What it does | Proof |
|---|---|---|
| **Deposit** | Public funds → one or two private notes | `deposit_proof` |
| **Transfer** | Private notes → private notes, new owner | `transfer_proof` |
| **Withdraw** | Private notes → public funds at a real address | `withdraw_proof` |

Every amount is range-constrained to 128 bits in **every** circuit, so a proof
cannot satisfy a balance equation by wrapping around the BN254 field.

A **relayer** broadcasts transactions so a user never has to pay gas from the
address they are trying to keep private. It is paid with an optional second
note (`C2`) created by the same proof. The relayer can censor, but it cannot
steal, forge, or deanonymise: it never learns amounts or note contents.

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
