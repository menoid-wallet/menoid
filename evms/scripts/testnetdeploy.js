/**
 * Testnet deployment
 *
 * The deployment flow is network agnostic now - scripts/deploy.js
 * derives the relayer noid keys, deploys the verifiers + NoidPool,
 * registers the relayer and writes deployments/<network>.json.
 *
 * Deploy to a testnet with:
 *
 *    npx hardhat run scripts/deploy.js --network sepolia
 *    npx hardhat run scripts/deploy.js --network baseSepolia
 *    npx hardhat run scripts/deploy.js --network monad
 */

console.error(
    "testnetdeploy.js is deprecated: run `npx hardhat run scripts/deploy.js --network <network>` instead"
);

process.exit(1);
