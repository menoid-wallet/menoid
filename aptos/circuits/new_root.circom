pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

/**
 * NewRoot — proves correct incremental (filled-subtree) insertion of one leaf,
 * with the subtree arrays COMMITTED AS A HASH to keep the public-signal count tiny.
 *
 * Aptos's Groth16 verifier deserializes one G1 point per public signal in pure
 * Move; 40 subtree signals made that the dominant cost (EXECUTION_LIMIT_REACHED).
 * So we pass only `oldSubtreesHash` (public) + the private `oldSubtrees` witness
 * (bound by the hash), and OUTPUT `newRoot` + `newSubtreesHash`. The contract
 * stores just the hash; the relayer keeps the actual subtrees off-chain.
 *
 * Public signal order (snarkjs: outputs first, then public inputs):
 *   [ newRoot, newSubtreesHash, oldSubtreesHash, commitment, leafIndex ]   (5 → 6 IC)
 *
 * subtreesHash is a sequential Poseidon(2) fold:
 *   acc = s[0]; acc = Poseidon(acc, s[i]) for i = 1..depth-1.
 */

template SubtreesHash(n) {
    signal input in[n];
    signal output out;
    component h[n - 1];
    signal acc[n];
    acc[0] <== in[0];
    for (var i = 1; i < n; i++) {
        h[i - 1] = Poseidon(2);
        h[i - 1].inputs[0] <== acc[i - 1];
        h[i - 1].inputs[1] <== in[i];
        acc[i] <== h[i - 1].out;
    }
    out <== acc[n - 1];
}

template NewRoot(depth) {
    // ── public inputs ──
    signal input oldSubtreesHash;   // bound to the contract's stored hash
    signal input commitment;        // leaf being inserted
    signal input leafIndex;         // == contract next_idx

    // ── private witness ──
    signal input oldSubtrees[depth]; // actual filled_subtrees (relayer-supplied)

    // ── outputs (public) ──
    signal output newRoot;
    signal output newSubtreesHash;

    var zeros[20] = [
        0,
        14744269619966411208579211824598458697587494354926760081771325075741142829156,
        7423237065226347324353380772367382631490014989348495481811164164159255474657,
        11286972368698509976183087595462810875513684078608517520839298933882497716792,
        3607627140608796879659380071776844901612302623152076817094415224584923813162,
        19712377064642672829441595136074946683621277828620209496774504837737984048981,
        20775607673010627194014556968476266066927294572720319469184847051418138353016,
        3396914609616007258851405644437304192397291162432396347162513310381425243293,
        21551820661461729022865262380882070649935529853313286572328683688269863701601,
        6573136701248752079028194407151022595060682063033565181951145966236778420039,
        12413880268183407374852357075976609371175688755676981206018884971008854919922,
        14271763308400718165336499097156975241954733520325982997864342600795471836726,
        20066985985293572387227381049700832219069292839614107140851619262827735677018,
        9394776414966240069580838672673694685292165040808226440647796406499139370960,
        11331146992410411304059858900317123658895005918277453009197229807340014528524,
        15819538789928229930262697811477882737253464456578333862691129291651619515538,
        19217088683336594659449020493828377907203207941212636669271704950158751593251,
        21035245323335827719745544373081896983162834604456827698288649288827293579666,
        6939770416153240137322503476966641397417391950902474480970945462551409848591,
        10941962436777715901943463195175331263348098796018438960955633645115732864202
    ];

    // 1) Bind oldSubtrees to the committed hash.
    component ohash = SubtreesHash(depth);
    for (var i = 0; i < depth; i++) { ohash.in[i] <== oldSubtrees[i]; }
    oldSubtreesHash === ohash.out;

    // 2) Filled-subtree insertion → newRoot + newSubtrees.
    component n2b = Num2Bits(depth);
    n2b.in <== leafIndex;

    signal cur[depth + 1];
    cur[0] <== commitment;
    signal newSub[depth];
    component hh[depth];
    signal left[depth];
    signal right[depth];

    for (var i = 0; i < depth; i++) {
        left[i]  <== cur[i]   + n2b.out[i] * (oldSubtrees[i] - cur[i]);
        right[i] <== zeros[i] + n2b.out[i] * (cur[i] - zeros[i]);
        hh[i] = Poseidon(2);
        hh[i].inputs[0] <== left[i];
        hh[i].inputs[1] <== right[i];
        cur[i + 1] <== hh[i].out;
        newSub[i] <== left[i];
    }
    newRoot <== cur[depth];

    // 3) Commit the new subtrees as a hash.
    component nhash = SubtreesHash(depth);
    for (var i = 0; i < depth; i++) { nhash.in[i] <== newSub[i]; }
    newSubtreesHash <== nhash.out;
}

component main {public [oldSubtreesHash, commitment, leafIndex]} = NewRoot(20);
