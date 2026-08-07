/**
 * The words behind the quick-reply buttons.
 *
 * These go out as the user's own words, to a real correspondent, under their own
 * address — so they are deliberately plain. Anything with personality in it
 * would be putting words in someone's mouth, and the recipient has no way to
 * tell it was a button press rather than a sentence they wrote.
 *
 * Shared between the tap path and the typed path so that "yes" typed and "yes"
 * tapped send the identical sentence.
 */
export const YES_BODY = 'Yes, that works for me.';
export const NO_BODY = "No, that doesn't work for me.";
