# Menoid v1-mainnet — Architecture

> Status: **proposal** · 2026-10-14 · branch `v1-mainnet`
>
> Covers: (1) viewing keys, (2) one multi-token pool with hidden token pointers and
> pool-executed private swaps, (3) which mainnets to deploy on within ₹500, and where
> to host the backend. Nothing here is implemented yet.

---

## 0. Scope and isolation

| | **V1 demo** (unchanged) | **v1-mainnet** (this document) |
|---|---|---|
| Clients | Extension + Android app | Website only (`app.menoid.xyz`) |
| Chains | 6 testnets | Monad first, then Base, Polygon (EVM only) |
| Modes | Open + Noid | Noid only — user connects an existing wallet (MetaMask, Rabby, WalletConnect…) |
| Assets | Native coin only | Native + whitelisted ERC-20s in **one** pool |
| Backend | current relayer (Render + Mongo) | **separate** relayer/indexer service + separate DB |
| Keys | `sign("menoid_Wallet")` | new message + new domain separators (§3.1) |

Isolation rules:

- No code path, contract, database or key is shared with the demo. The demo backend keeps
  running where it is; the mainnet service gets its own deployment and its own database.
- Mainnet key derivation uses its own domain (`menoid/v1m/...`), so the same wallet derives
  **different** keys on mainnet than on testnet. Testers have signed `menoid_Wallet` on many
  testnet builds; that signature must never be worth anything on mainnet.
- Because nothing is migrated, the note format, circuits and contracts below are free to
  break compatibility with the demo.

---

## 1. What has to change from the testnet protocol

Found while reading `evms/`, `wallet/wallet-extension` and `wallet/backend`. Items 1–3 are
blockers for real funds.

| # | Finding | Where | Consequence | Fix (section) |
|---|---|---|---|---|
| 1 | Encrypted notes are **not bound to the proof**. `encryptedNote1..3` never enter `publicSignals`. | `NoidPool._singleTransfer`, `_singleWithdraw` | The relayer, or anyone copying the tx from the mempool with a higher tip, can replace a ciphertext. The tx still succeeds, the receiver can never decrypt `r`, and the note is **unspendable forever**. Griefing that burns user funds. | `extDataHash` public input (§4.4) |
| 2 | Phase-2 trusted setup is a single local contribution (`*_0000.zkey → *_final.zkey`). | `evms/build/` | Whoever holds that toxic waste can forge proofs and drain the pool. README already says "testnet only". | Multi-party ceremony for the one remaining circuit (§9) |
| 3 | `enabled[]` and `output_enabled[]` are **public signals**. | circuits + contract | The chain learns how many notes were spent and whether change was created. DOCS.md says the proof "never leaks how many notes you spent" — it does. | Fixed-shape transactions with dummy notes (§4.3) |
| 4 | `ROOT_HISTORY_SIZE = 10`. | `poolLib.sol` | At Monad's block rate, 10 roots flush in seconds under load and proofs go stale in flight. | 100 (§5) |
| 5 | Backend only indexes txs it broadcast itself; a whole pool lives in **one Mongo document**; the wallet downloads the full state every 10 s and trusts it without checking the root on-chain. | `poolIndexer.js`, `PoolState.js`, `PoolContext.tsx` | Third-party deposits are missed until a repair runs. Mongo's 16 MB document cap is reached at roughly 20k notes. Bandwidth grows with pool size. | Chain-scanning indexer, paginated note feed, client-side root check (§8) |
| 6 | Relayer is immutable (`relayerCommitment`) and Monad transfers charge **no fee**. | `NoidPool` constructor, `NoidSendModal.tsx` | Relayer key can never rotate; on mainnet every Monad tx is a pure loss. | Relayer registry + per-token fee quotes (§4.6) |
| 7 | Registration is permanent; message `menoid_Wallet` is generic and phishable; no rotation. | `NoidPool.register` | A phished signature burns that address for Noid Mode forever. | Explicit message, `rotateKeys`, `updateViewingKey` (§3) |
| 8 | Each tree insert does 20 Poseidon calls through `PoseidonHasher` at **~31.8k gas each (measured)** ≈ 650k gas per note. | `poolLib.updatePool` | A 3-output transfer is ~2.5M gas, mostly hashing. | Insert outputs as one 4-leaf chunk: 21 hashes instead of 60 (§5) |
| 9 | Moving from extension to website: keys derived from a signature inside a web page; smart-contract / passkey / some MPC wallets sign **non-deterministically**. | — | XSS or a compromised dependency steals every connected user's notes. A non-deterministic signer derives a different identity every login. | Key-handling rules (§3.6) |

---

## 2. Note format v1m

Everything else in this document builds on this. The change from testnet: the **token goes
inside the note**, and the owner goes inside a randomised **note public key** (`npk`), so a
commitment can be finished on-chain without revealing the owner.

```
D_UC = 1, D_NK = 2, D_NPK = 3, D_CM = 4, D_NF = 5          (domain separators)

uc  = Poseidon(D_UC, address, spendPk.x, spendPk.y)       user commitment (public identity)
nk  = Poseidon(D_NK, sk)                                   nullifier key
npk = Poseidon(D_NPK, uc, r)                               note public key — hides the owner
cm  = Poseidon(D_CM, token, amount, npk)                   note commitment
nf  = Poseidon(D_NF, nk, cm, r)                            nullifier
```

- `token` is `uint160(tokenAddress)`. Native coins are auto-wrapped (WMON / WETH / WPOL), so
  every asset is an ERC-20 inside the pool and there is one code path. The UI shows "MON",
  not "WMON".
- **This is the hidden token pointer.** In a transfer, `token` is a private input. It appears
  only inside `cm` (a hash), so the chain cannot tell a USDC transfer from a MON transfer.
  All tokens share one tree, so the anonymity set of a transfer is every note in the pool.
- `npk` is a hash of `uc` with fresh randomness, so two notes for the same user are
  unlinkable, and a contract that sees `npk` learns nothing about the owner.
- `nk` is derived one-way from `sk`. It lets someone **detect** spends without being able
  to **make** them. That is what makes a full viewing key possible (§3).
- `nf` includes `r`, which only someone who decrypted the note knows. Holding `nk` alone is
  not enough to test arbitrary on-chain commitments against a user's nullifiers.
- `cm` is a 4-input Poseidon, so the contract can compute it with `PoseidonT5` for deposits
  and swap outputs (§4.5).

Encrypted note plaintext (binary, replaces the JSON `{amount, randomness}`):

```
version u8 | flags u8 | token 20B | amount 16B | r 31B | memo ≤32B (optional)
```

ECIES over secp256k1 as today, with a compressed ephemeral key. Ciphertext drops from ~219 B
(measured, JSON) to ~135 B. That matters on Base, where calldata pays an L1 data fee.

---

## 3. Viewing keys

### 3.1 Key tree

All keys come from one wallet signature, computed in the browser and never sent anywhere.

```
msg  = "Menoid v1-mainnet — create my private account keys.\n"
       "Only sign this on https://app.menoid.xyz.\n"
       "Anyone holding this signature can spend your private balance.\n"
       "Key index: {k}"
sig  = personal_sign(msg)                        same message on every chain → one identity everywhere

seed = keccak256("menoid/v1m/seed" ‖ sig)        master secret — never stored, never transmitted
sk   = keccak256("menoid/v1m/spend" ‖ seed) mod l   spending key (BabyJubJub)
nk   = Poseidon(D_NK, sk)                         nullifier key
ivk  = keccak256("menoid/v1m/ivk" ‖ seed ‖ e)     incoming viewing key, epoch e (secp256k1 private key)
ovk  = keccak256("menoid/v1m/ovk" ‖ seed ‖ e)     outgoing viewing key, epoch e (32-byte symmetric key)
uc   = Poseidon(D_UC, address, sk·B8)            registered on-chain with ivkPub
```

`k` (key index) changes only when a spending key is compromised (§3.5). `e` (viewing epoch)
changes whenever the user rotates viewing keys (§3.4). Both start at 0.

### 3.2 What each key can do

| Key | Sees incoming notes | Knows what's spent (true balance) | Sees outgoing payments (to whom) | Can spend |
|---|---|---|---|---|
| `seed` / `sk` | ✅ | ✅ | ✅ | ✅ |
| **Full viewing key** `FVK = (address, uc, ivk, nk, ovk, birthday)` | ✅ | ✅ | ✅ | ❌ |
| **Incoming viewing key** `IVK = (address, uc, ivk, birthday)` | ✅ | ❌ (upper bound only) | ❌ | ❌ |
| **Payment disclosure** (one tx) | that note only | that note only | — | ❌ |

Why the FVK cannot spend: spending requires proving knowledge of `sk` such that
`uc = Poseidon(D_UC, address, sk·B8)`. The FVK has `nk = Poseidon(D_NK, sk)`, and Poseidon
is one-way.

Why the FVK sees spends: for every note it decrypts, it has `cm` and `r`, so it computes
`nf = Poseidon(D_NF, nk, cm, r)` and looks for that nullifier on-chain.

`birthday` is the registration block per chain, so a viewer starts scanning there, not at
genesis.

### 3.3 Outgoing records

Today a sender cannot later see whom they paid. The receiver note is encrypted to the
receiver, and the change note only shows what came back. Every spend transaction in v1m
emits one extra ciphertext:

```
key        = HKDF(ovk_e, nf[0])                           nf[0] is always a real input's nullifier
outRecord  = XChaCha20-Poly1305(key, {
               action, token, amount,
               recipientAddress, recipientUc, recipientNoteR,   ← lets the sender prove the payment later
               fee, relayerUc, memo })
```

Keying by `nf[0]` means no nonce bookkeeping and **no trial decryption**. A FVK holder
already computes the user's nullifiers. For each one found on-chain, it reads that tx's
`outRecord` and decrypts it directly. `outRecord` is included in `extDataHash` (§4.4), so a
relayer cannot strip it. Cost is roughly 120 bytes of calldata per tx.

### 3.4 Time-scoped viewing keys (epochs)

An IVK or FVK covers everything forever. To share one quarter with an accountant:

- `updateViewingKey(newIvkPub)` on-chain changes the encryption key senders use. `uc` stays
  the same, so balances are untouched. The contract keeps `ivkHistory[address]` with the
  block of each change.
- The user's own wallet scans with every `ivk_0..ivk_e`.
- Sharing `(ivk_e, ovk_e, nk)` reveals only notes received and payments sent during epoch `e`,
  plus their spend status. Sharing `nk` does not leak other epochs, because `nf` needs `r`
  (see §2).

This also limits damage if an IVK leaks: rotate, and future notes are private again.

The contract function costs about 50k gas and must exist **from day one**, because the pool
is not upgradeable (§9). The UI can ship later.

### 3.5 Spending key compromise (`rotateKeys`)

If the signature or seed leaks, the funds are at risk, not just privacy. `rotateKeys(newUc,
newIvkPub)` is called from the EOA and re-points the address at an identity derived with key
index `k+1`. Senders immediately use the new identity. Notes locked to the old `uc` remain
spendable by the old `sk`, so the wallet must sweep them to the new identity at once (a race
against the attacker, but no worse than any key leak). The old `uc` stays in `ucHistory` so
history remains scannable.

### 3.6 Key handling on a website (new risk vs. the extension)

1. **Determinism check at setup.** Ask for the signature twice and compare. If they differ
   (smart-contract wallets, passkey wallets, some MPC wallets), refuse with "this wallet type
   is not supported for private mode yet". Never register a non-reproducible identity.
2. **Identity check at every login.** Recompute `uc` and compare it with
   `registrationOf(address)` read from the user's own RPC. On mismatch, stop. Never create a
   new identity silently.
3. **Keys live in a dedicated Web Worker.** `seed`/`sk` never touch React state,
   `localStorage` or logs. `ivk`/`nk`/`ovk` may be cached in IndexedDB encrypted under a
   session key so the balance shows without re-signing. Lock after inactivity.
4. **App origin with no third-party scripts.** `app.menoid.xyz`, separate from the marketing
   site. Strict CSP, no analytics/chat widgets, pinned dependencies, Subresource Integrity on
   the zk artifacts. A single injected script would steal every user's keys.

### 3.7 Sharing formats and UX

- `mfvk1…` / `mivk1…`: versioned, checksummed strings (bech32m without the 90-char limit, as
  Zcash does) carrying the fields in §3.2 plus key index and epoch.
- **"Open with a viewing key"** on the website: paste a key and get a read-only dashboard
  (balances by token, history, CSV export). Scanning runs in the viewer's browser against the
  public note feed. The viewing key is never sent to the backend.
- **Payment disclosure**: a JSON receipt `{chainId, txHash, cm, token, amount, uc, r}`. The
  verifier recomputes `cm`, finds it in that tx's `NoteCreated` log, and checks `uc` is
  registered to the claimed address. It proves "address X received A of token T in tx H"
  without sharing any key. No circuit is needed.
- Later (v1.1): a small off-chain `disclose` circuit that proves `nf = Poseidon(D_NF, nk, cm, r)`
  for a disclosed note, so a verifier can confirm "unspent / spent" without receiving `nk`.

No protocol-level or "regulator" viewing key. The only keys that exist are the user's.

---

## 4. One multi-token pool with private swaps

### 4.1 Model

```
                    ┌──────────────── NoidPool (one per chain) ────────────────┐
 deposit(token,…) ─►│  token whitelist · Merkle tree of cm · nullifier set      │
                    │                                                           │
 transact(proof) ──►│  action = TRANSFER │ WITHDRAW │ SWAP                      │
   (via relayer)    │                                  │                        │
                    │                                  ▼                        │
                    │                        ISwapAdapter (whitelisted) ──► DEX / aggregator
                    └───────────────────────────────────────────────────────────┘
```

- One contract holds every whitelisted token. There are no per-token pools.
- One circuit, `spend` (4 inputs → 3 outputs), serves transfer, withdraw **and** swap. One
  verifier, one ceremony, and every spend has the same proof shape.
- **Deposits need no proof.** The amount and token are public anyway, so the contract computes
  `cm = PoseidonT5(D_CM, token, amount, npk)` itself. This removes `deposit_proof.circom`, its
  verifier, its ceremony, and a client-side proof from every deposit.

### 4.2 What is public, per action

| | token | amount | who |
|---|---|---|---|
| Deposit | public | public | depositor public (inherent) |
| **Transfer** | **hidden** | **hidden** | hidden |
| Withdraw | public | public | destination public, source hidden |
| **Swap** | public (in & out) | public (in & out) | **hidden** |

A swap reveals "someone in the pool traded X USDC for Y MON at time t". It does not reveal
who, their balance, where the funds came from, or where the output goes. That is inherent to
executing against public DEX liquidity.

### 4.3 The `spend` circuit

```circom
template Spend(nIn /*4*/, nOut /*3*/, depth /*20*/) {
    // ── public ──
    signal input root;                 // one tree per call (treeId passed to the contract)
    signal input nullifiers[nIn];      // always 4 — dummies look random
    signal input outCommitments[nOut]; // always 3 — dummies are zero-value notes
    signal input publicAmount;         // value leaving the pool: 0 for transfer
    signal input publicToken;          // token leaving the pool: 0 for transfer
    signal input relayer;              // fee-note owner (uc), checked against the registry
    signal input extDataHash;          // binds everything the proof does not compute (§4.4)

    // ── private ──
    signal input sk, ownerAddress, token;
    signal input inAmount[nIn], inR[nIn], inPathElements[nIn][depth], inPathIndices[nIn][depth];
    signal input outAmount[nOut], outR[nOut], outOwner[nOut];

    // ownership
    pk = BabyPbk(sk);
    uc = Poseidon(D_UC, ownerAddress, pk.Ax, pk.Ay);
    nk = Poseidon(D_NK, sk);

    for i in inputs:
        RangeCheck(128)(inAmount[i]);
        cm = Poseidon(D_CM, token, inAmount[i], Poseidon(D_NPK, uc, inR[i]));
        nullifiers[i] === Poseidon(D_NF, nk, cm, inR[i]);
        isReal = 1 - IsZero(inAmount[i]);                 // zero-value input = dummy
        isReal * (MerkleRoot(cm, path_i) - root) === 0;

    for j in outputs:
        RangeCheck(128)(outAmount[j]);
        outCommitments[j] === Poseidon(D_CM, token, outAmount[j], Poseidon(D_NPK, outOwner[j], outR[j]));
    outOwner[2] === relayer;                             // slot 2 is always the fee note

    RangeCheck(128)(publicAmount);
    Σ inAmount === Σ outAmount + publicAmount;           // conservation
    publicAmount * (token - publicToken) === 0;          // token public only when value leaves
    extDataSquare <== extDataHash * extDataHash;         // keep extDataHash constrained
}
```

Properties:

- **Per-token conservation for free.** A single `token` signal feeds every input and output
  commitment, so a proof cannot spend USDC notes and create MON notes. Transfers cannot mint
  across assets.
- **Token hidden in transfers.** With `publicAmount = 0`, the contract forces
  `publicToken = 0`, and the last constraint leaves `token` unconstrained by public data.
- **Fixed shape.** There are always 4 nullifiers and 3 output commitments. Unused inputs are
  zero-value notes, whose nullifiers are still stored and look random. Unused outputs are
  zero-value notes to self. The `enabled` masks and their leak (finding 3) disappear.
- 12 public signals instead of 19, and roughly 6–7k gas less verification per signal removed.
- Rough size is ~30k constraints, which fits the Hermez `powersOfTau28_hez_final_17` you
  already use. Expect browser proving in the low seconds; measure once written.

Slot usage:

| action | out[0] | out[1] | out[2] | 4th leaf (on-chain) |
|---|---|---|---|---|
| transfer | receiver | change | relayer fee | zero |
| withdraw | dummy | change | relayer fee | zero |
| swap | dummy | change (tokenIn) | relayer fee | **swap output** (tokenOut) |

### 4.4 `extDataHash` — binding what the proof doesn't compute

```solidity
struct ExtData {
    uint8   action;              // TRANSFER | WITHDRAW | SWAP
    address recipient;           // withdraw destination (0 otherwise)
    bool    unwrapNative;        // withdraw WMON → MON
    bytes[3] encryptedOutputs;   // ciphertexts for out[0..2]
    bytes   outgoingRecord;      // §3.3
    SwapParams swap;             // zeroed unless action == SWAP
}
struct SwapParams {
    address adapter; address tokenOut; uint256 minAmountOut;
    bytes32 npkOut;  bytes encryptedOut; uint64 deadline; bytes routeData;
}

extDataHash = uint256(keccak256(abi.encode(block.chainid, address(this), ext))) % SNARK_FIELD
```

The proof is now bound to its ciphertexts (fixes finding 1), its withdraw destination, its
outgoing record, the exact swap route and minimum output, the deadline, and the chain and
pool. A relayer can deliver the tx or drop it, but cannot change any of it.

### 4.5 Swap execution — the pool calls the swap

```
transact(proof, pub, ext) with ext.action == SWAP
 1. require ext.swap.deadline ≥ now, adapter whitelisted, tokenOut whitelisted
 2. verify extDataHash and the proof   (publicToken = tokenIn, publicAmount = amountIn)
 3. mark 4 nullifiers spent; check root is known
 4. before = tokenOut.balanceOf(pool)
 5. tokenIn.safeTransfer(adapter, amountIn)                 // no standing approvals
 6. adapter.swap(tokenIn, amountIn, tokenOut, minAmountOut, routeData)
 7. out = tokenOut.balanceOf(pool) - before                // measured, never trusted from return data
    require(out ≥ minAmountOut); require(no tokenIn left on adapter)
 8. cmOut = PoseidonT5(D_CM, tokenOut, out, npkOut)
 9. insert chunk [out0, out1, out2, cmOut]
10. emit NoteCreated × 4, SwapExecuted(tokenIn, amountIn, tokenOut, out, cmOut)
```

- **Why `npkOut` works.** The user commits in advance to `npkOut = Poseidon(D_NPK, uc, rOut)`
  and puts `rOut` in `encryptedOut`. The amount is unknown at proving time, so the contract
  finishes the commitment once it knows `out`. The wallet decrypts `rOut`, reads `out` from
  `SwapExecuted`, and checks `cm` matches. No owner information is ever revealed.
- `nonReentrant` on every entry point. State changes (nullifiers, change/fee notes) happen
  before the external call.
- Exact-input swaps only. A partial fill reverts rather than creating refund notes.
- **Adapters are replaceable; the pool is not.** Start with:
  - `AggregatorAdapter`: calls a whitelisted router with calldata from an off-chain quote.
    KyberSwap and 0x both list Monad mainnet, Uniswap's Trading API supports Monad, and all
    three cover Base and Polygon. The quote's taker/recipient must be the adapter. Verify
    router addresses per chain at deploy time (0x's Settler changes on upgrade).
  - `UniswapV3Adapter`: explicit path, as a fallback when aggregator APIs are down.
- **Quote → proof → submit flow.** The website asks the relayer's `/quote/swap` (which holds
  the aggregator API keys), gets `routeData` and `minAmountOut`, proves locally, and posts to
  `/relay` before the deadline (~60 s).
- **MEV.** `minAmountOut` is inside the proof, so a sandwich can extract at most the
  slippage the user allowed. Default to tight slippage. Use private submission where it
  exists; Polygon has a public mempool, so take care there.
- **Amount correlation is the main privacy risk.** "Deposit 1,234.56 USDC, swap 1,234.56 USDC
  a minute later" links itself. The UI should warn about exact-amount round trips and nudge
  toward partial amounts and waiting. **v2:** batched swaps (collect intents over N blocks,
  execute one aggregate swap, distribute pro-rata claim notes, as Penumbra/Aztec Connect did)
  hide individual amounts.

### 4.6 Fees and relayers

- The fee is always `out[2]`, in **the same token** as the spend, so it hides nothing extra.
  The relayer decrypts `encryptedOutputs[2]` (it is the recipient), prices it, and accepts if
  the fee is at least gas × margin. This is the same model as today's `transfer.controller.js`,
  but it applies on Monad too.
- `relayer` is a public input checked against `relayers[uc]` (owner-managed registry). This
  lets keys rotate, lets more relayers join later, and lets a user self-relay with a
  zero-value fee note.
- The relayer periodically swaps accumulated fee notes to native through the pool itself and
  withdraws to its hot wallet for gas.

### 4.7 Token whitelist

- `addToken(token, maxDeposit, tvlCap)` by the owner multisig. Only standard ERC-20s: no
  fee-on-transfer, no rebasing.
- **Blacklist risk:** USDC and USDT can freeze an address. If the pool address is frozen,
  every shielded unit of that token is stuck (this happened to Tornado's USDC). Accept and
  disclose it, or keep stablecoin caps low.
- Suggested launch set per chain: native (wrapped), USDC, USDT, WETH or BTC wrapper where
  liquid. Take addresses from each issuer's official list at deploy time.

---

## 5. Contract surface (sketch)

```solidity
// identity
function register(bytes32 uc, bytes calldata ivkPub) external;
function updateViewingKey(bytes calldata newIvkPub) external;              // epoch++ (§3.4)
function rotateKeys(bytes32 newUc, bytes calldata newIvkPub) external;     // key index++ (§3.5)
function registrationOf(address) external view
    returns (bytes32 uc, bytes memory ivkPub, uint32 keyIndex, uint32 epoch);

// value
function deposit(address token, DepositNote[] calldata notes) external payable;  // ≤4 notes, no proof
function transact(Proof calldata p, PublicInputs calldata pub, ExtData calldata ext) external;

// views for clients
function isKnownRoot(uint256 treeId, bytes32 root) external view returns (bool);
function currentRoot(uint256 treeId) external view returns (bytes32, uint32 nextIndex);

// admin (multisig) — cannot move user funds
addToken / setCaps / setAdapter / setRelayer / pauseDeposits / pauseSwaps
// withdrawals and transfers are NEVER pausable
```

Changes inside the tree library:

- **4-leaf chunk insertion.** Every operation inserts exactly one aligned chunk of 4 leaves
  (zero-padded). The contract hashes the chunk (3 hashes) and climbs 18 levels: **21 Poseidon
  calls per operation instead of 60**. The off-chain `IncrementalMerkleTree` gives the same
  root, because zero leaves are ordinary leaves. Depth 20 then holds 262k operations per tree,
  and the contract rolls to a new tree as it does today.
- `ROOT_HISTORY_SIZE = 100`.
- Keep `commitmentExists` (rejects duplicate `cm`), the per-call duplicate-nullifier check,
  and checks-effects-interactions ordering.
- Keep the runtime under **24 KB** (EIP-170 applies on Base and Polygon; Monad allows 128 KB)
  so one bytecode deploys everywhere. Today's `NoidPool` is 14.3 KB.

---

## 6. Gas and cost

### 6.1 Measured (current testnet contracts, Hardhat, optimizer 200)

| Contract | Deploy gas |
|---|---|
| PoseidonT3 library | 3,693,374 |
| PoseidonHasher wrapper | 154,569 |
| DepositVerifier | 430,210 |
| TransferVerifier | 715,863 |
| WithdrawVerifier | 716,139 |
| NoidPool | 4,756,653 |
| register() relayer | 138,091 |
| **Total** | **10,604,899** |

Also measured: PoseidonT5 deploys for 3,721,230 gas. One Poseidon hash via the wrapper costs
about 31.8k gas, and a 2-note deposit used 1,443,282 gas (`evms/test/deposit_test.txt`).

### 6.2 Estimated v1m deployment (per chain)

| Item | Gas | Note |
|---|---|---|
| PoseidonT3 + PoseidonT5 | ~7.4M | **0 on Base**: both already exist at the canonical CREATE2 addresses `0x3333…3B93` and `0x5553…9767` (checked on-chain). Monad and Polygon have the CREATE2 proxy, so deploy through it to get the same addresses. |
| SpendVerifier (12 public inputs) | ~0.7M | replaces 3 verifiers |
| NoidPool v1m | ~5.5M | current pool + token registry, swap path, extData |
| AggregatorAdapter + UniswapV3Adapter | ~1.0M | |
| Register relayer, add ~5 tokens, set adapters | ~0.6M | |
| **Total incl. ~25% margin** | **~19M** (Monad, Polygon) · **~10M** (Base) | |

### 6.3 Costs at today's prices

Live gas read from public RPCs on 2026-10-14: Monad **102 gwei**, Base **0.006 gwei**,
Polygon **~279 gwei**, Arbitrum **0.02 gwei**. Prices used: MON ≈ $0.03, POL ≈ $0.10,
ETH ≈ $2,500 (deliberately high), $1 ≈ ₹96.5.

| Chain | Deploy + add tokens | Per private tx (chunked ~1.2M gas) | Per private tx (unoptimized ~2.5M) |
|---|---|---|---|
| **Monad** | 19M × 102 gwei ≈ 1.9 MON ≈ **₹6** | ≈ ₹0.4 | ≈ ₹0.8 |
| **Base** | 10M × 0.006 gwei + L1 data fee ≈ **₹20–45** | ≈ ₹2 | ≈ ₹4 |
| **Polygon** | 19M × 279 gwei ≈ 5.3 POL ≈ **₹51** (₹275 if gas spikes to 1,500 gwei) | ≈ ₹3 | ≈ ₹7 |
| Arbitrum (optional 4th) | ~15.5M × 0.02 gwei ≈ **₹75** | ≈ ₹6 | ≈ ₹12 |
| Ethereum L1 (comparison) | ≈ ₹630 | ₹30+ | ₹60+ |

**Monad + Base + Polygon ≈ ₹80–120 total**, inside ₹500 with room for Arbitrum. Gas moves, so
re-check right before deploying and avoid Polygon gas spikes.

Monad-specific: **Monad charges the gas _limit_, not gas used**, at a 100 gwei floor (Monad
docs). The relayer must set `gasLimit ≈ estimateGas × 1.05`, never a round high number, and
must simulate before sending. A reverted tx still pays the full limit.

Not included in the ₹500:

- **Relayer float**, since the relayer pays gas up front. For example 50 MON (~₹145, ~350 txs),
  0.001 ETH on Base (~₹240), and 10 POL (~₹100).
- **Test transactions** after deploy.
- **Exchange withdrawal fees and minimums.** Buy each gas token where you can withdraw it
  directly on the target network (ETH on Base, POL on Polygon, MON on Monad). Exchange
  withdrawal fees can exceed the deployment itself.

---

## 7. Which chains

1. **Monad: launch here.** Cheapest by far, your testnet community is here, and Uniswap, 0x
   and KyberSwap all route on mainnet. Watch the gas-limit billing (§6.3).
2. **Base: second.** Cheapest ETH L2, deepest USDC liquidity, Poseidon libraries already
   deployed. The sequencer has no public mempool, which helps swaps.
3. **Polygon: third.** Still cheap, but gas is more volatile and the public mempool means
   more MEV on swaps.
4. Arbitrum as an optional fourth (very cheap, deep liquidity). **Skip Ethereum L1** for now:
   both deployment and per-tx relayer cost are out of budget.

The same identity (`uc`) works on all of them, because the signed message has no chain id.
Each chain still needs its own one-time `register()`.

---

## 8. Backend

### 8.1 Components

```
                 Cloudflare Pages (static)                 Hetzner CX22 (one box, docker compose)
  user ──► app.menoid.xyz  ──────────────────────────►  ┌──────────────────────────────────────┐
           · Next.js static export                      │ relayer API   /quote/fee /quote/swap │
           · proving in a Web Worker (snarkjs)          │               /relay                 │
           · keys never leave the browser               │ indexer       scans ALL pool events  │
           · verifies tree root on-chain itself         │               per chain, from deploy │
                                                        │ Postgres      notes, nullifiers      │
           user's own RPC (Alchemy/dRPC/public) ◄─────  │ Caddy         TLS                    │
                                                        └──────────────────────────────────────┘
```

- **Indexer reads the chain, not the relayer's receipts.** It follows `NoteCreated`,
  `NullifierSpent`, `SwapExecuted` and `Transacted` events from the deploy block for every
  pool, whoever submitted the tx. It pages `eth_getLogs` in small windows (the Monad testnet
  RPC caps a request at 100 blocks; check the mainnet provider's cap). Self-host it: extend
  the current `poolIndexer.js` into a log poller, or use Ponder. Envio's free tier is
  development-only, and its production tier starts at about $70/month.
- **Note feed, one row per note:**
  `GET /v1/{chain}/notes?fromLeaf=N&limit=…`,
  `GET /v1/{chain}/nullifiers?fromBlock=…`,
  `GET /v1/{chain}/root`.
  Every client downloads the same public data, so the feed reveals nothing about who is
  asking. **Never add a "my notes" endpoint.**
- **Clients trust the chain, not the backend.** The wallet rebuilds the tree from the feed,
  checks `isKnownRoot` via its own RPC before proving, and keeps leaves and decrypted notes in
  IndexedDB so each sync is incremental. A lying or broken backend can stall the wallet but
  cannot make it prove against a fake tree. With RPC log scanning as a fallback, the wallet
  works even if the backend is down.
- **Relayer:** checks the proof and fee, simulates, sends with a tight gas limit, and manages
  nonces per chain. Hot keys hold small balances and are topped up manually. The **contract
  owner is a multisig**, never the relayer key.
- **Logging:** keep no IP ↔ tx logs. Today's backend has `AnalyticsEvent` and `Install` models;
  the mainnet relayer should have nothing that links a request to a relayed transaction.
- **Database:** everything in it can be rebuilt from the chain, so Postgres on the same box
  with nightly dumps is enough. MongoDB Atlas M0 (free, 512 MB) also works if you keep one
  document per note.

### 8.2 Where to host

| Piece | Recommendation | Cost | Why |
|---|---|---|---|
| Website / app | **Cloudflare Pages** | ₹0 | Free tier allows commercial use. **Vercel Hobby is non-commercial**, and the current site is on Vercel. |
| Relayer + indexer + DB | **Hetzner CX22** (2 vCPU / 4 GB) | ~€3.79–4.59/mo ≈ ₹400–480 | Always on, flat price, room for all three services. |
| Free alternative | Oracle Cloud Always Free (ARM) | ₹0 | Generous, but account approval and idle reclamation are unreliable. |
| Managed alternatives | Fly.io (~$2–8/mo metered), Railway (~$5 + usage), Render Starter ($7/service) | | Easier, pricier or less predictable. |
| **Avoid** | Render **free** tier | | Spins down after 15 min. The cold start is the failure `deploy.txt` already documents for the demo backend. |
| RPC | Free tiers (Alchemy, dRPC, publicnode) with rotation, as `provider.js` does now | ₹0 | |

Running cost is therefore about **₹450/month** (or ₹0 on Oracle), plus the domain. The demo
backend stays on its current host.

---

## 9. Pre-mainnet security checklist

- [ ] **Phase-2 ceremony** for `spend` (the only circuit left). Phase 1 is the Hermez ptau you
      already use. Run phase 2 with p0tion, or a chained `snarkjs zkey contribute` with at
      least 3–5 independent contributors and a final random beacon from a future block hash.
      Publish the transcript. (Alternative: PLONK/FFLONK in snarkjs need no phase 2, at the
      cost of slower proving and/or higher verify gas.)
- [ ] Circuit static analysis (circomspect, Picus for under-constrained signals) plus a paid
      circuit and contract review before raising caps.
- [ ] **Guarded launch:** per-deposit cap and TVL cap per token; multisig can pause deposits
      and swaps only, never withdrawals or transfers. Non-upgradeable pool; if something is
      wrong, pause deposits, let users withdraw, redeploy.
- [ ] Optional rate limit per token per hour on withdraw volume, to limit the blast radius of
      a circuit bug.
- [ ] Decide on deposit screening (e.g. a sanctions-oracle check in `deposit`) before launch.
      Association-set designs (Privacy Pools) are a v2 option.
- [ ] Tests: everything in `test/noidpool-test.js` ported, plus ciphertext-swap griefing
      (must now revert), fixed-shape dummies, swap with a malicious adapter (must revert or
      deliver at least `minAmountOut`), the 4-leaf chunk root matching the off-chain tree,
      and key rotation/epoch scanning.

---

## 10. Build order

1. `circuits/spend.circom` + witness tests (note format §2, constraints §4.3).
2. `NoidPoolV1M.sol` with identity, deposit, transact, chunked tree and extData, plus
   `AggregatorAdapter` and `UniswapV3Adapter`; port tests; fork tests against Monad mainnet
   DEX liquidity.
3. Phase-2 ceremony → `SpendVerifier.sol`.
4. Indexer + note feed + relayer v1m (fresh service, fresh DB).
5. `app.menoid.xyz`: wallet connect, key worker, deposit/transfer/withdraw/swap, viewing-key
   export and view-only mode.
6. Deploy on Monad (caps low) → Base → Polygon.
