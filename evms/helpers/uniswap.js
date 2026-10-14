const { ethers } = require("ethers");

/**
 * Uniswap V3 routing — Menoid picks the route, not the user.
 *
 * For a swap tokenIn -> tokenOut the backend (relayer) tries every fee tier
 * directly, and every two-hop route through a connector token (e.g. WMON,
 * USDC), quotes each candidate with QuoterV2, and takes the best output.
 * The chosen path becomes the swap's routeData; the user's proof binds it.
 *
 * Refer: notes/swap.txt
 */

const FEE_TIERS = [100, 500, 3000, 10000];

// Verified on-chain (router.factory() == quoter.factory(), router.WETH9() == wrappedNative).
const UNISWAP_V3 = {
    monad: {
        chainId: 143,
        factory: "0x204FAca1764B154221e35c0d20aBb3c525710498",
        swapRouter02: "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900",
        quoterV2: "0x661e93cca42afacb172121ef892830ca3b70f08d",
        wrappedNative: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A"   // WMON
    },
    base: {
        chainId: 8453,
        factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
        swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
        quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
        wrappedNative: "0x4200000000000000000000000000000000000006"   // WETH
    },
    polygon: {
        chainId: 137,
        factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        wrappedNative: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270"   // WPOL
    },
    arbitrum: {
        chainId: 42161,
        factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
        swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
        wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"   // WETH
    }
};

const FACTORY_ABI = ["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"];
const QUOTER_ABI = [
    "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)"
];

// tokenIn | fee | token | fee | ... | tokenOut   (20-byte addresses, 3-byte fees)
function encodePath(tokens, fees) {
    if (tokens.length !== fees.length + 1) throw new Error("a path needs one fee per hop");
    let path = "0x";
    for (let i = 0; i < fees.length; i++) {
        path += ethers.utils.getAddress(tokens[i]).slice(2) + fees[i].toString(16).padStart(6, "0");
    }
    return (path + ethers.utils.getAddress(tokens[tokens.length - 1]).slice(2)).toLowerCase();
}

function decodePath(path) {
    const hex = path.replace(/^0x/, "");
    const tokens = [ethers.utils.getAddress("0x" + hex.slice(0, 40))];
    const fees = [];
    for (let i = 40; i < hex.length; i += 46) {
        fees.push(parseInt(hex.slice(i, i + 6), 16));
        tokens.push(ethers.utils.getAddress("0x" + hex.slice(i + 6, i + 46)));
    }
    return { tokens, fees };
}

function contractsFor({ factory, quoter, provider }) {
    return {
        factory: typeof factory === "string" ? new ethers.Contract(factory, FACTORY_ABI, provider) : factory,
        quoter: typeof quoter === "string" ? new ethers.Contract(quoter, QUOTER_ABI, provider) : quoter
    };
}

/**
 * Best Uniswap V3 route for an exact-input swap.
 *
 *   connectors: tokens worth hopping through (WMON, USDC, ...)
 *   returns { path, tokens, fees, amountOut }
 *
 * Only pools that exist are quoted; a candidate whose quote reverts (no
 * liquidity in range) is skipped.
 */
async function findBestRoute({ factory, quoter, provider, tokenIn, tokenOut, amountIn, connectors = [], feeTiers = FEE_TIERS }) {
    ({ factory, quoter } = contractsFor({ factory, quoter, provider }));
    const zero = ethers.constants.AddressZero;
    const exists = async (a, b, fee) => (await factory.getPool(a, b, fee)) !== zero;

    const candidates = [];
    for (const fee of feeTiers) {
        candidates.push(exists(tokenIn, tokenOut, fee).then((ok) => ok && { tokens: [tokenIn, tokenOut], fees: [fee] }));
    }
    const mids = connectors
        .map((c) => ethers.utils.getAddress(c))
        .filter((c) => c !== ethers.utils.getAddress(tokenIn) && c !== ethers.utils.getAddress(tokenOut));
    for (const mid of mids) {
        for (const f1 of feeTiers) {
            for (const f2 of feeTiers) {
                candidates.push(
                    Promise.all([exists(tokenIn, mid, f1), exists(mid, tokenOut, f2)]).then(
                        ([a, b]) => a && b && { tokens: [tokenIn, mid, tokenOut], fees: [f1, f2] }
                    )
                );
            }
        }
    }

    let best = null;
    for (const candidate of (await Promise.all(candidates)).filter(Boolean)) {
        const path = encodePath(candidate.tokens, candidate.fees);
        try {
            const quote = await quoter.callStatic.quoteExactInput(path, amountIn);
            const amountOut = BigInt(quote.amountOut.toString());
            if (!best || amountOut > best.amountOut) best = { ...candidate, path, amountOut };
        } catch {
            // no liquidity in range on this route
        }
    }
    if (!best) throw new Error("no Uniswap V3 route for this pair");
    return best;
}

// the minimum the user accepts: quote minus slippage (basis points)
function withSlippage(amountOut, slippageBps = 50) {
    return (BigInt(amountOut) * BigInt(10000 - slippageBps)) / 10000n;
}

module.exports = {
    FEE_TIERS,
    UNISWAP_V3,
    encodePath,
    decodePath,
    findBestRoute,
    withSlippage
};
