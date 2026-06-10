// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC20 HTLC for NOCK/USDC OTC on Base.
///         Buyer locks USDC; seller withdraws with preimageJam where keccak256(jam) == hashlock.
interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract AtomicNock {
    address public immutable usdc;
    address public owner;
    uint16 public feeBps = 50; // 0.5%
    uint16 public constant MAX_FEE_BPS = 500; // 5%
    uint256 public constant MIN_TIMELOCK = 30 minutes;
    bool public paused;
    uint256 public totalLocked;
    uint256 public feesAccrued;

    struct Lock {
        address buyer;
        address seller;
        uint256 amount;
        bytes32 hashlock;
        uint256 timelock;
        uint16 feeBps;
        bool withdrawn;
        bool refunded;
    }

    mapping(bytes32 => Lock) public locks;

    /// @dev Minimal non-reentrancy guard (1 = unlocked, 2 = entered).
    uint256 private _entered = 1;

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
    event FeesClaimed(address indexed to, uint256 amount);
    event PausedSet(bool paused);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier nonReentrant() {
        require(_entered == 1, "reentrant");
        _entered = 2;
        _;
        _entered = 1;
    }

    modifier whenNotPaused() {
        require(!paused, "paused");
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

    function pause() external onlyOwner {
        paused = true;
        emit PausedSet(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit PausedSet(false);
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
    ) external whenNotPaused nonReentrant returns (bytes32 id) {
        require(seller != address(0), "zero seller");
        require(amount > 0, "zero amount");
        require(timelock >= block.timestamp + MIN_TIMELOCK, "timelock too soon");

        id = swapId(seller, msg.sender, amount, hashlock, timelock);
        require(locks[id].amount == 0, "swap exists");

        _safeTransferFrom(msg.sender, address(this), amount);

        locks[id] = Lock({
            buyer: msg.sender,
            seller: seller,
            amount: amount,
            hashlock: hashlock,
            timelock: timelock,
            feeBps: feeBps,
            withdrawn: false,
            refunded: false
        });
        totalLocked += amount;

        emit Locked(id, msg.sender, seller, amount, hashlock, timelock);
    }

    function withdraw(bytes32 id, bytes calldata preimageJam) external nonReentrant {
        Lock storage c = locks[id];
        require(c.amount > 0, "no swap");
        require(msg.sender == c.seller, "not seller");
        require(!c.withdrawn, "withdrawn");
        require(!c.refunded, "refunded");
        require(keccak256(preimageJam) == c.hashlock, "bad preimage");

        c.withdrawn = true;
        uint256 amount = c.amount;
        totalLocked -= amount;

        uint256 fee = (amount * c.feeBps) / 10_000;
        uint256 sellerAmount = amount - fee;
        feesAccrued += fee;

        _safeTransfer(c.seller, sellerAmount);
        emit Withdrawn(id, c.seller, sellerAmount, fee);
    }

    function refund(bytes32 id) external nonReentrant {
        Lock storage c = locks[id];
        require(c.amount > 0, "no swap");
        require(msg.sender == c.buyer, "not buyer");
        require(!c.withdrawn, "withdrawn");
        require(!c.refunded, "refunded");
        require(block.timestamp >= c.timelock, "timelock active");

        c.refunded = true;
        totalLocked -= c.amount;
        // Refunds are fee-free: the swap did not complete.
        _safeTransfer(c.buyer, c.amount);
        emit Refunded(id, c.buyer);
    }

    function claimFees() external nonReentrant returns (uint256 amount) {
        amount = feesAccrued;
        require(amount > 0, "no fees");
        feesAccrued = 0;
        _safeTransfer(owner, amount);
        emit FeesClaimed(owner, amount);
    }

    function sweep() external nonReentrant returns (uint256 amount) {
        uint256 bal = IERC20(usdc).balanceOf(address(this));
        // reverts on underflow if accounting is off
        amount = bal - totalLocked - feesAccrued;
        require(amount > 0, "nothing to sweep");
        _safeTransfer(owner, amount);
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

    // --- SafeERC20 (inline) ---------------------------------------------------
    // Minimal SafeERC20 over the fixed `usdc` token: tolerates tokens that return
    // no value on success (USDT-style) and reverts when one returns `false`.

    function _safeTransfer(address to, uint256 value) private {
        _callOptionalReturn(abi.encodeWithSelector(IERC20.transfer.selector, to, value));
    }

    function _safeTransferFrom(address from, address to, uint256 value) private {
        _callOptionalReturn(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, value));
    }

    function _callOptionalReturn(bytes memory data) private {
        (bool ok, bytes memory ret) = usdc.call(data);
        if (!ok) {
            // Bubble up the token's own revert reason (e.g. USDC "blacklisted").
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            revert("transfer failed");
        }
        if (ret.length == 0) {
            // No return value: trust only if the token actually has code.
            require(usdc.code.length > 0, "token has no code");
        } else {
            require(abi.decode(ret, (bool)), "transfer returned false");
        }
    }
}
