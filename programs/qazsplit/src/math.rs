use anchor_lang::prelude::*;

use crate::errors::QazSplitError;

pub fn calculate_allocations(amount: u64, shares_bps: &[u16]) -> Result<Vec<u64>> {
    require!(amount > 0, QazSplitError::ZeroAmount);
    require!(!shares_bps.is_empty(), QazSplitError::InvalidRecipientCount);

    let mut allocations = Vec::with_capacity(shares_bps.len());
    let mut distributed = 0u64;

    for (index, share) in shares_bps.iter().enumerate() {
        let allocation = if index + 1 == shares_bps.len() {
            amount
                .checked_sub(distributed)
                .ok_or(QazSplitError::ArithmeticOverflow)?
        } else {
            let product = (amount as u128)
                .checked_mul(*share as u128)
                .ok_or(QazSplitError::ArithmeticOverflow)?;
            u64::try_from(product / 10_000u128)
                .map_err(|_| QazSplitError::ArithmeticOverflow)?
        };

        distributed = distributed
            .checked_add(allocation)
            .ok_or(QazSplitError::ArithmeticOverflow)?;
        allocations.push(allocation);
    }

    Ok(allocations)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allocates_exact_50_30_20_split() {
        assert_eq!(
            calculate_allocations(10_000_000, &[5_000, 3_000, 2_000]).unwrap(),
            vec![5_000_000, 3_000_000, 2_000_000]
        );
    }

    #[test]
    fn assigns_rounding_remainder_to_last_recipient() {
        assert_eq!(
            calculate_allocations(10_000_001, &[5_000, 3_000, 2_000]).unwrap(),
            vec![5_000_000, 3_000_000, 2_000_001]
        );
    }

    #[test]
    fn rejects_zero_amount() {
        assert!(calculate_allocations(0, &[5_000, 5_000]).is_err());
    }
}

