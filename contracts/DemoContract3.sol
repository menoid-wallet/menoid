// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DemoContract3 {
    struct Auction {
        address seller;
        string itemName;
        uint256 highestBid;
        address highestBidder;
        uint256 endTime;
        bool ended;
    }

    uint256 public nextAuctionId;

    mapping(uint256 => Auction) public auctions;

    event AuctionCreated(
        uint256 indexed auctionId,
        address indexed seller,
        string itemName,
        uint256 endTime
    );

    event BidPlaced(
        uint256 indexed auctionId,
        address indexed bidder,
        uint256 amount
    );

    event AuctionEnded(
        uint256 indexed auctionId,
        address indexed winner,
        uint256 amount
    );

    function createAuction(
        string calldata itemName,
        uint256 durationSeconds
    ) external {
        auctions[nextAuctionId] = Auction({
            seller: msg.sender,
            itemName: itemName,
            highestBid: 0,
            highestBidder: address(0),
            endTime: block.timestamp + durationSeconds,
            ended: false
        });

        emit AuctionCreated(
            nextAuctionId,
            msg.sender,
            itemName,
            block.timestamp + durationSeconds
        );

        nextAuctionId++;
    }

    function placeBid(uint256 auctionId) external payable {
        Auction storage auction = auctions[auctionId];

        require(block.timestamp < auction.endTime, "Auction ended");
        require(msg.value > auction.highestBid, "Bid too low");

        if (auction.highestBidder != address(0)) {
            payable(auction.highestBidder).transfer(
                auction.highestBid
            );
        }

        auction.highestBid = msg.value;
        auction.highestBidder = msg.sender;

        emit BidPlaced(auctionId, msg.sender, msg.value);
    }

    function endAuction(uint256 auctionId) external {
        Auction storage auction = auctions[auctionId];

        require(block.timestamp >= auction.endTime, "Auction active");
        require(!auction.ended, "Already ended");

        auction.ended = true;

        if (auction.highestBidder != address(0)) {
            payable(auction.seller).transfer(
                auction.highestBid
            );
        }

        emit AuctionEnded(
            auctionId,
            auction.highestBidder,
            auction.highestBid
        );
    }
}