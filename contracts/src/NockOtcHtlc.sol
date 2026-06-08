// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC20 HTLC for NOCK/USDC OTC on Base.
///         Buyer locks USDC; seller withdraws with preimageJam where keccak256(jam) == hashlock.
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract NockOtcHtlc {
    address public immutable usdc;

    /// @notice Treasury / admin. Receives swap fees and is the sweep destination.
    address public owner;

    /// @notice Swap fee in basis points (1e4 = 100%). Taken from the seller's
    ///         withdraw amount on the happy path only; refunds are fee-free.
    uint16 public feeBps = 50; // 0.5%

    /// @notice Hard cap so the owner can never set an abusive fee.
    uint16 public constant MAX_FEE_BPS = 500; // 5%

    /// @notice Sum of all currently-locked USDC, so sweep() can never touch it.
    uint256 public totalLocked;

    struct Lock {
        address buyer;
        address seller;
        uint256 amount;
        bytes32 hashlock;
        uint256 timelock;
        bool withdrawn;
        bool refunded;
    }

    mapping(bytes32 => Lock) public locks;

    event Locked(
        bytes32 indexed swapId,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    );
    event Withdrawn(bytes32 indexed swapId, address indexed seller, uint256 sellerAmount, uint256 fee);
    event Refunded(bytes32 indexed swapId, address indexed buyer);
    event Swept(address indexed to, uint256 amount);
    event FeeUpdated(uint16 oldFeeBps, uint16 newFeeBps);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(address usdc_, address owner_) {
        require(usdc_ != address(0), "zero usdc");
        require(owner_ != address(0), "zero owner");
        usdc = usdc_;
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        require(newFeeBps <= MAX_FEE_BPS, "fee too high");
        emit FeeUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    function swapId(
        address seller,
        address buyer,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(seller, buyer, amount, hashlock, timelock));
    }

    function lock(
        address seller,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    ) external returns (bytes32 id) {
        require(seller != address(0), "zero seller");
        require(amount > 0, "zero amount");
        require(timelock > block.timestamp, "timelock in past");

        id = swapId(seller, msg.sender, amount, hashlock, timelock);
        require(locks[id].amount == 0, "swap exists");

        require(
            IERC20(usdc).transferFrom(msg.sender, address(this), amount),
            "transferFrom failed"
        );

        locks[id] = Lock({
            buyer: msg.sender,
            seller: seller,
            amount: amount,
            hashlock: hashlock,
            timelock: timelock,
            withdrawn: false,
            refunded: false
        });
        totalLocked += amount;

        emit Locked(id, msg.sender, seller, amount, hashlock, timelock);
    }

    function withdraw(bytes32 id, bytes calldata preimageJam) external {
        Lock storage c = locks[id];
        require(c.amount > 0, "no swap");
        require(msg.sender == c.seller, "not seller");
        require(!c.withdrawn, "withdrawn");
        require(!c.refunded, "refunded");
        require(keccak256(preimageJam) == c.hashlock, "bad preimage");

        c.withdrawn = true;
        uint256 amount = c.amount;
        totalLocked -= amount;

        uint256 fee = (amount * feeBps) / 10_000;
        uint256 sellerAmount = amount - fee;

        require(IERC20(usdc).transfer(c.seller, sellerAmount), "transfer failed");
        if (fee > 0) {
            require(IERC20(usdc).transfer(owner, fee), "fee transfer failed");
        }
        emit Withdrawn(id, c.seller, sellerAmount, fee);
    }

    function refund(bytes32 id) external {
        Lock storage c = locks[id];
        require(c.amount > 0, "no swap");
        require(msg.sender == c.buyer, "not buyer");
        require(!c.withdrawn, "withdrawn");
        require(!c.refunded, "refunded");
        require(block.timestamp >= c.timelock, "timelock active");

        c.refunded = true;
        totalLocked -= c.amount;
        // Refunds are fee-free: the swap did not complete.
        require(IERC20(usdc).transfer(c.buyer, c.amount), "transfer failed");
        emit Refunded(id, c.buyer);
    }

    /// @notice Recover USDC sent to the contract outside of lock() (e.g. a plain
    ///         transfer from a broken gasless-delegator flow). Permissionless, but
    ///         can only move the balance NOT backing active locks, to the treasury.
    ///         Plain ERC20 transfers can't be rejected on receipt (no hook), so
    ///         recovery is the only remedy.
    function sweep() external returns (uint256 amount) {
        uint256 bal = IERC20(usdc).balanceOf(address(this));
        amount = bal - totalLocked; // reverts on underflow if accounting is off
        require(amount > 0, "nothing to sweep");
        require(IERC20(usdc).transfer(owner, amount), "transfer failed");
        emit Swept(owner, amount);
    }

    function getLock(bytes32 id)
        external
        view
        returns (
            address buyer,
            address seller,
            uint256 amount,
            bytes32 hashlock,
            uint256 timelock,
            bool withdrawn,
            bool refunded
        )
    {
        Lock storage c = locks[id];
        return (
            c.buyer,
            c.seller,
            c.amount,
            c.hashlock,
            c.timelock,
            c.withdrawn,
            c.refunded
        );
    }
}
