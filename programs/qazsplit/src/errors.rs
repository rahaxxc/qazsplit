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
    #[msg("An agreement must contain between one and five milestones.")]
    InvalidMilestoneCount,
    #[msg("Milestone names must be nonblank and at most 32 UTF-8 bytes.")]
    InvalidMilestoneName,
    #[msg("Mock USDC must have six decimals.")]
    InvalidMintDecimals,
    #[msg("Only a configured recipient may approve their own share.")]
    UnauthorizedRecipient,
    #[msg("This recipient already approved the agreement.")]
    AlreadyApproved,
    #[msg("Every recipient must approve before a milestone can be paid.")]
    AgreementPending,
    #[msg("The selected milestone does not exist.")]
    InvalidMilestoneIndex,
    #[msg("This milestone has already been paid.")]
    MilestoneAlreadyPaid,
}
