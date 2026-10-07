use anchor_lang::prelude::*;

#[error_code]
pub enum QazSplitError {
    #[msg("A split must contain between two and five recipients.")]
    InvalidRecipientCount,
    #[msg("Each recipient must have exactly one share.")]
    RecipientShareLengthMismatch,
    #[msg("Shares must total exactly 10,000 basis points.")]
    InvalidShareTotal,
    #[msg("Every recipient share must be greater than zero.")]
    ZeroShare,
    #[msg("Recipients must be unique.")]
    DuplicateRecipient,
    #[msg("Payment amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Arithmetic overflow while calculating allocations.")]
    ArithmeticOverflow,
    #[msg("The supplied mint does not match this split.")]
    WrongMint,
    #[msg("Provide exactly one recipient token account per configured recipient.")]
    InvalidRecipientAccountCount,
    #[msg("Recipient token account is not writable.")]
    RecipientAccountNotWritable,
    #[msg("Recipient token account is owned by the wrong program.")]
    InvalidTokenAccountProgram,
    #[msg("Recipient token account uses the wrong mint.")]
    RecipientMintMismatch,
    #[msg("Recipient token account belongs to the wrong wallet.")]
    RecipientOwnerMismatch,
}

