const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("menoAccount Demo Interactions", function () {
    let owner;
    let user1;
    let user2;

    let meno1;
    let meno2;

    let shop;
    let token;
    let nft;
    let auction;

    beforeEach(async function () {
        [owner, user1, user2] = await ethers.getSigners();

        /*
            Deploy meno Accounts
        */
        const menoAccount = await ethers.getContractFactory("menoAccount");

        meno1 = await menoAccount.deploy(user1.address);
        await meno1.deployed();

        meno2 = await menoAccount.deploy(user2.address);
        await meno2.deployed();

        /*
            Deploy DemoContract1 (Shopping)
        */
        const DemoContract1 = await ethers.getContractFactory("DemoContract1");

        shop = await DemoContract1.deploy();
        await shop.deployed();

        /*
            Deploy DemoToken
        */
        const DemoToken = await ethers.getContractFactory("DemoToken");

        token = await DemoToken.deploy();
        await token.deployed();

        /*
            Deploy DemoNFT
        */
        const DemoNFT = await ethers.getContractFactory("DemoNFT");

        nft = await DemoNFT.deploy();
        await nft.deployed();

        /*
            Deploy DemoContract3 (Auction)
        */
        const DemoContract3 = await ethers.getContractFactory("DemoContract3");

        auction = await DemoContract3.deploy();
        await auction.deployed();
    });

    it("should interact with shopping contract", async function () {
        /*
            Admin adds products
        */
        await shop.addProduct(
            "Laptop",
            ethers.utils.parseEther("1")
        );

        await shop.addProduct(
            "Phone",
            ethers.utils.parseEther("0.5")
        );

        /*
            Fund menoAccount
        */

        await user1.sendTransaction({
            to: await meno1.address,
            value: ethers.utils.parseEther("2")
        });

        /*
            Create order through menoAccount
        */
        const createOrderData = shop.interface.encodeFunctionData(
            "createOrder",
            [0]
        );

        await meno1
            .connect(user1)
            .execute(
                await shop.address,
                ethers.utils.parseEther("1"),
                createOrderData
            );

        /*
            Admin marks delivered
        */
        await shop.delivered(0);

        /*
            User confirms received via menoAccount
        */
        const receivedData = shop.interface.encodeFunctionData(
            "receivedOrder",
            [0]
        );

        await meno1
            .connect(user1)
            .execute(
                await shop.address,
                0,
                receivedData
            );
    });

    it("should interact with ERC20 token", async function () {
        /*
            Mint ERC20 through menoAccount
        */
        const mintData = token.interface.encodeFunctionData(
            "mint",
            [ethers.utils.parseEther("100")]
        );

        await meno1
            .connect(user1)
            .execute(
                await token.address,
                0,
                mintData
            );

        /*
            Transfer ERC20 through menoAccount
        */
        const transferData = token.interface.encodeFunctionData(
            "transfer",
            [
                await meno2.address,
                ethers.utils.parseEther("25")
            ]
        );

        await meno1
            .connect(user1)
            .execute(
                await token.address,
                0,
                transferData
            );

        expect(
            await token.balanceOf(
                await meno2.address
            )
        ).to.equal(ethers.utils.parseEther("25"));
    });

    it("should interact with NFT contract", async function () {
        /*
            Mint NFT through menoAccount
        */
        const mintNFTData = nft.interface.encodeFunctionData(
            "mint",
            []
        );

        await meno1
            .connect(user1)
            .execute(
                await nft.address,
                0,
                mintNFTData
            );

        expect(
            await nft.ownerOf(0)
        ).to.equal(await meno1.address);

        /*
            Transfer NFT through menoAccount
        */
        const transferNFTData = nft.interface.encodeFunctionData(
            "transferFrom",
            [
                await meno1.address,
                await meno2.address,
                0
            ]
        );

        await meno1
            .connect(user1)
            .execute(
                await nft.address,
                0,
                transferNFTData
            );

        expect(
            await nft.ownerOf(0)
        ).to.equal(await meno2.address);
    });

    it("should interact with auction contract", async function () {
        /*
            Create auction through menoAccount
        */
        const createAuctionData =
            auction.interface.encodeFunctionData(
                "createAuction",
                [
                    "Gaming PC",
                    3600
                ]
            );

        await meno1
            .connect(user1)
            .execute(
                await auction.address,
                0,
                createAuctionData
            );

        /*
            Fund meno2
        */
        await user2.sendTransaction({
            to: await meno2.address,
            value: ethers.utils.parseEther("3")
        });

        /*
            Place bid through menoAccount
        */
        const bidData =
            auction.interface.encodeFunctionData(
                "placeBid",
                [0]
            );

        await meno2
            .connect(user2)
            .execute(
                await auction.address,
                ethers.utils.parseEther("2"),
                bidData
            );

        const auctionData =
            await auction.auctions(0);

        expect(
            auctionData.highestBidder
        ).to.equal(await meno2.address);
    });
});