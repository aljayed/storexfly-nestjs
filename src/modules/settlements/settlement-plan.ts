/** Integer-paisa allocation of one transfer, including held earlier cycles.
 * Re-recording a cycle may pay only the new earnings; money already sent or
 * deducted is never reused to clear a new debt. */
export function planPayout(input: {
  payoutCents: number;
  previousPayoutCents?: number;
  previousDuesCents?: number;
  carried: { period: string; cents: number }[];
  outstandingCents: number;
}) {
  const increase = Math.max(
    0,
    input.payoutCents - (input.previousPayoutCents ?? 0),
  );
  const available =
    increase + input.carried.reduce((sum, c) => sum + c.cents, 0);
  const deduction = Math.min(Math.max(0, input.outstandingCents), available);
  let remaining = deduction;
  const carried = input.carried.map((c) => {
    const duesCents = Math.min(remaining, c.cents);
    remaining -= duesCents;
    return { ...c, duesCents, transferCents: c.cents - duesCents };
  });
  return {
    availableCents: available,
    deductionCents: deduction,
    transferCents: available - deduction,
    currentDuesCents: (input.previousDuesCents ?? 0) + remaining,
    currentTransferCents: increase - remaining,
    carried,
  };
}
