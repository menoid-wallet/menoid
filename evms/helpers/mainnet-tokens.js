/**
 * The tokens each MAINNET pool accepts — a guarded launch: every token has a
 * small PER-DEPOSIT cap, in whole tokens, about $5 at the prices of the day it
 * was listed (stablecoins 5, the native coin and BTC / ETH wrappers in kind).
 * Swaps can only buy tokens listed here (the pool checks depositsEnabled).
 *
 * Who is listed: widely held tokens and memecoins with real two-sided
 * liquidity on a venue the pool can route through (Uniswap V3; on Monad also
 * Capricorn, nad.fun's DEX), checked first on a fork: a $1 and a $5 buy sold
 * straight back keep at least 97% (pool fees + slippage), and plain transfers
 * move exact amounts (no transfer fee, no rebasing: the pool rejects those).
 * Addresses: CoinGecko / GeckoTerminal, checked on-chain (symbol, decimals).
 *
 * scripts/deploy.js accepts a new pool's list; scripts/list-tokens.js brings a
 * live pool up to date (configureToken for each token it does not accept yet).
 * The owner raises caps later with configureToken.
 */
const MAINNET_TOKENS = {
    // Monad (2026-10-15). The memecoins trade on Capricorn: add that venue
    // first (scripts/add-venue.js), or swaps into them find no route.
    143: [
        { symbol: "WMON", address: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", cap: "20" },
        { symbol: "USDC", address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", cap: "5" },
        { symbol: "USDT0", address: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", cap: "5" },
        { symbol: "AUSD", address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", cap: "5" },
        { symbol: "USDe", address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", cap: "5" },
        { symbol: "USD1", address: "0x111111d2bf19e43C34263401e0CAd979eD1cdb61", cap: "5" },
        { symbol: "WETH", address: "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242", cap: "0.002" },
        { symbol: "WBTC", address: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", cap: "0.00006" },
        { symbol: "cbBTC", address: "0xd18B7EC58Cdf4876f6AFebd3Ed1730e4Ce10414b", cap: "0.00006" },
        { symbol: "LBTC", address: "0xecAc9C5F704e954931349Da37F60E39f515c11c1", cap: "0.00006" },
        { symbol: "shMON", address: "0x1B68626dCa36c7fE922fD2d55E4f631d962dE19c", cap: "200" },
        { symbol: "gMON", address: "0x8498312A6B3CbD158bf0c93AbdCF29E6e4F55081", cap: "200" },
        { symbol: "sMON", address: "0xA3227C5969757783154C60bF0bC1944180ed81B9", cap: "200" },
        { symbol: "aprMON", address: "0x0c65A0BC65a5D819235B71F554D210D3F80E0852", cap: "200" },
        // memecoins
        { symbol: "CHOG", address: "0x350035555E10d9AfAF1566AaebfCeD5BA6C27777", cap: "3200" },
        { symbol: "emo", address: "0x81A224F8A62f52BdE942dBF23A56df77A10b7777", cap: "7300" },
        { symbol: "MOLANDAK", address: "0x7B2728c04aD436153285702e969e6EfAc3a97777", cap: "20000" },
        { symbol: "shramp", address: "0x42a4aA89864A794dE135B23C6a8D2E05513d7777", cap: "29000" },
        { symbol: "BOB", address: "0x21E325B059Cd83d4037C82F0F5998Ba2dF3d7777", cap: "72000" },
        { symbol: "ANAGO", address: "0x3Ec7310937281CA4Bf89D5bB11704bE9b7ff7777", cap: "88000" },
        { symbol: "MONCAT", address: "0x0158aBFf6D8344B35b5afFFe7DBEFC431B731A70", cap: "83000" },
        { symbol: "NADS", address: "0x39B9E06f226FF6D7500c870B82333AACbD2F7777", cap: "120000" },
        { symbol: "EGG", address: "0xD10cf12099f5Fb424Bc77401DF49f0c785657777", cap: "250000" },
        { symbol: "HOGDOG", address: "0xc911Ba7aEE487f5145702c20c20a40d9e5B87777", cap: "180000" },
        { symbol: "143", address: "0x3842751a46D23B41A47E702473dFf316E6237777", cap: "180000" },
        { symbol: "BC", address: "0x228c673cae7aaD0F4D9F309616D6b546356b7777", cap: "200000" },
        { symbol: "MONI", address: "0x0CC9B2e2AcD7BACfF79eb7dB48F5662B622E7777", cap: "490000" },
        { symbol: "FLING", address: "0xA9da3C77eC7cDc4DfaA1FE142AF583543D1c540F", cap: "70000" }
    ],

    // Base (2026-10-15)
    8453: [
        { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", cap: "0.002" },
        { symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", cap: "5" },
        { symbol: "USDT", address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", cap: "5" },
        { symbol: "DAI", address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", cap: "5" },
        { symbol: "USDS", address: "0x820C137fa70C8691f0e44Dc420a5e53c168921Dc", cap: "5" },
        { symbol: "USDe", address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", cap: "5" },
        { symbol: "EURC", address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", cap: "5" },
        { symbol: "cbBTC", address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", cap: "0.000062" },
        { symbol: "WBTC", address: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", cap: "0.000062" },
        { symbol: "cbETH", address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", cap: "0.0019" },
        { symbol: "wstETH", address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", cap: "0.0017" },
        { symbol: "weETH", address: "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", cap: "0.002" },
        { symbol: "rETH", address: "0xB6fe221Fe9EeF5aBa221c348bA20A1Bf5e73624c", cap: "0.0018" },
        { symbol: "AERO", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", cap: "6" },
        { symbol: "VIRTUAL", address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", cap: "7.7" },
        { symbol: "MORPHO", address: "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842", cap: "2.2" },
        { symbol: "AAVE", address: "0x63706e401c06ac8513145b7687A14804d17f814b", cap: "0.034" },
        { symbol: "UNI", address: "0xc3De830EA07524a0761646a6a4e4be0e114a3C83", cap: "0.73" },
        { symbol: "LINK", address: "0x88Fb150BDc53A65fe94Dea0c9BA0a6dAf8C6e196", cap: "0.42" },
        { symbol: "ZORA", address: "0x1111111111166b7FE7bd91427724B487980aFc69", cap: "780" },
        { symbol: "COMP", address: "0x9e1028F5F1D5eDE59748FFceE5532509976840E0", cap: "0.24" },
        { symbol: "CRV", address: "0x8Ee73c484A26e0A5df2Ee2a4960B789967dd0415", cap: "15" },
        { symbol: "WELL", address: "0xA88594D404727625A9437C3f886C7643872296AE", cap: "2600" },
        { symbol: "VVV", address: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf", cap: "0.22" },
        { symbol: "AIXBT", address: "0x4F9Fd6Be4a90f2620860d680c0d4d5Fb53d1A825", cap: "270" },
        { symbol: "CLANKER", address: "0x1bc0c42215582d5A085795f4baDbaC3ff36d1Bcb", cap: "0.44" },
        { symbol: "BNKR", address: "0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b", cap: "18000" },
        { symbol: "uSOL", address: "0x9B8Df6E244526ab5F6e6400d331DB28C8fdDdb55", cap: "0.049" },
        { symbol: "cbXRP", address: "0xcb585250f852C6c6bf90434AB21A00f02833a4af", cap: "3.9" },
        { symbol: "uDOGE", address: "0x12E96C2BFEA6E835CF8Dd38a5834fa61Cf723736", cap: "63" },
        // memecoins
        { symbol: "BRETT", address: "0x532f27101965dd16442E59d40670FaF5eBB142E4", cap: "1100" },
        { symbol: "TOSHI", address: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4", cap: "50000" },
        { symbol: "DEGEN", address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", cap: "5400" },
        { symbol: "KEYCAT", address: "0x9a26F5433671751C3276a065f57e5a02D2817973", cap: "9700" },
        { symbol: "MIGGLES", address: "0xB1a03EdA10342529bBF8EB700a06C60441fEf25d", cap: "3600" },
        { symbol: "SKI", address: "0x768BE13e1680b5ebE0024C42c896E3dB59ec0149", cap: "2000" },
        { symbol: "doginme", address: "0x6921B130D297cc43754afba22e5EAc0FBf8Db75b", cap: "76000" },
        { symbol: "BENJI", address: "0xBC45647eA894030a4E9801Ec03479739FA2485F0", cap: "4300" },
        { symbol: "TYBG", address: "0x0d97F261b1e88845184f678e2d1e7a98D9FD38dE", cap: "750000" },
        { symbol: "MOG", address: "0x2Da56AcB9Ea78330f947bD57C54119Debda7AF71", cap: "50000000" },
        { symbol: "PEPE", address: "0x52b492a33E447Cdb854c7FC19F1e57E8BfA1777D", cap: "970000000" },
        { symbol: "TOBY", address: "0xb8D98a102b0079B69FFbc760C8d857A31653e56e", cap: "630000000" },
        { symbol: "CAW", address: "0xdfBEA88C4842d30c26669602888d746D30F9D60d", cap: "770000000" },
        { symbol: "HIGHER", address: "0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe", cap: "31000" },
        { symbol: "DRB", address: "0x3ec2156D4c0A9CBdAB4a016633b7BcF6a8d68Ea2", cap: "30000" },
        { symbol: "LAPTOP", address: "0xB095274743941e953c746F9C228DA9c18Bb6ec29", cap: "65" },
        { symbol: "MOEW", address: "0x15aC90165f8B45A80534228BdCB124A011F62Fee", cap: "23000" },
        { symbol: "RUSSELL", address: "0x0C5142BC58f9A61AB8C3D2085DD2F4e550c5cE0B", cap: "4100" },
        { symbol: "MOCHI", address: "0xF6e932Ca12afa26665dC4dDE7e27be02A7c02e50", cap: "6300000" },
        { symbol: "NOICE", address: "0x9Cb41FD9dC6891BAe8187029461bfAADF6CC0C69", cap: "590000" }
    ]
};

module.exports = { MAINNET_TOKENS };
