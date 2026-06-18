//! Human token amount ↔ atomic units. Port of `toAtomic`/`parseUsdc`.

use alloy_primitives::U256;

/// Convert a human token amount string to atomic units for `decimals` places.
/// Truncates fractional digits beyond the token's precision (matches `toAtomic`).
pub fn to_atomic(amount: &str, decimals: u32) -> U256 {
    let t = amount.trim();
    let (whole, frac_in) = t.split_once('.').unwrap_or((t, ""));
    // frac = f.padEnd(decimals,'0').slice(0, decimals)
    let mut frac = String::with_capacity(decimals as usize);
    frac.push_str(frac_in);
    while frac.len() < decimals as usize {
        frac.push('0');
    }
    frac.truncate(decimals as usize);

    let whole = if whole.is_empty() { "0" } else { whole };
    let frac = if frac.is_empty() { "0" } else { &frac };

    let scale = U256::from(10u8).pow(U256::from(decimals));
    let whole_val = U256::from_str_radix(whole, 10).unwrap_or(U256::ZERO);
    let frac_val = U256::from_str_radix(frac, 10).unwrap_or(U256::ZERO);
    whole_val * scale + frac_val
}

/// USDC helper pinned to 6 decimals (back-compat; prefer the on-chain decimals).
pub fn parse_usdc(amount: &str) -> U256 {
    to_atomic(amount, 6)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(n: u128) -> U256 {
        U256::from(n)
    }

    #[test]
    fn scales_a_6_decimal_token() {
        assert_eq!(to_atomic("1.0", 6), u(1_000_000));
        assert_eq!(to_atomic("1", 6), u(1_000_000));
        assert_eq!(to_atomic("0.5", 6), u(500_000));
        assert_eq!(to_atomic("2.5", 6), u(2_500_000));
    }

    #[test]
    fn scales_an_18_decimal_token() {
        assert_eq!(to_atomic("1.0", 18), U256::from(10u8).pow(U256::from(18u8)));
    }

    #[test]
    fn truncates_beyond_precision() {
        assert_eq!(to_atomic("1.23456789", 6), u(1_234_567));
    }

    #[test]
    fn parse_usdc_pinned_to_6() {
        assert_eq!(parse_usdc("1.0"), u(1_000_000));
    }
}
