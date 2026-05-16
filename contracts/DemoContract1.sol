// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DemoContract1 {
    struct Product {
        string name;
        uint256 price;
        bool exists;
    }

    struct Order {
        address buyer;
        uint256 productId;
        uint256 amountPaid;
        bool delivered;
        bool completed;
    }

    address public admin;

    uint256 public nextProductId;
    uint256 public nextOrderId;

    mapping(uint256 => Product) public products;
    mapping(uint256 => Order) public orders;

    event ProductAdded(
        uint256 indexed productId,
        string name,
        uint256 price
    );

    event OrderCreated(
        uint256 indexed orderId,
        address indexed buyer,
        uint256 indexed productId
    );

    event Delivered(uint256 indexed orderId);

    event ReceivedConfirmed(uint256 indexed orderId);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
        _;
    }

    constructor() {
        admin = msg.sender;
    }

    function addProduct(
        string calldata name,
        uint256 price
    ) external onlyAdmin {
        products[nextProductId] = Product({
            name: name,
            price: price,
            exists: true
        });

        emit ProductAdded(nextProductId, name, price);

        nextProductId++;
    }

    function createOrder(uint256 productId) external payable {
        Product memory product = products[productId];

        require(product.exists, "Invalid product");
        require(msg.value == product.price, "Wrong ETH amount");

        orders[nextOrderId] = Order({
            buyer: msg.sender,
            productId: productId,
            amountPaid: msg.value,
            delivered: false,
            completed: false
        });

        emit OrderCreated(nextOrderId, msg.sender, productId);

        nextOrderId++;
    }

    function delivered(uint256 orderId) external onlyAdmin {
        Order storage order = orders[orderId];

        require(!order.delivered, "Already delivered");

        order.delivered = true;

        emit Delivered(orderId);
    }

    function receivedOrder(uint256 orderId) external {
        Order storage order = orders[orderId];

        require(msg.sender == order.buyer, "Not buyer");
        require(order.delivered, "Not delivered");
        require(!order.completed, "Already completed");

        order.completed = true;

        payable(admin).transfer(order.amountPaid);

        emit ReceivedConfirmed(orderId);
    }
}