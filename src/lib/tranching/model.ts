/** Fictional examples in settlement-asset units. Fees, rounding and latency are omitted. */
export interface Ledger {
  assets: number;
  seniorClaim: number;
  seniorSupply: number;
  juniorSupply: number;
}

function nonnegative(value: number) {
  if (!Number.isFinite(value) || value < 0)
    throw new RangeError('Expected a finite, nonnegative amount');
}

export function initialLedger(juniorCapital = 20): Ledger {
  nonnegative(juniorCapital);
  return {
    assets: 100 + juniorCapital,
    seniorClaim: 100,
    seniorSupply: 100,
    juniorSupply: juniorCapital,
  };
}

export function claims(ledger: Ledger) {
  const juniorClaim = Math.max(0, ledger.assets - ledger.seniorClaim);
  return {
    juniorClaim,
    seniorPrice: ledger.seniorSupply ? ledger.seniorClaim / ledger.seniorSupply : 0,
    juniorPrice: ledger.juniorSupply ? juniorClaim / ledger.juniorSupply : 0,
  };
}

/** Only the vested part of an already supplied distribution enters the claims. */
export function vestYield(ledger: Ledger, senior: number, junior: number): Ledger {
  nonnegative(senior);
  nonnegative(junior);
  return {
    ...ledger,
    assets: ledger.assets + senior + junior,
    seniorClaim: ledger.seniorClaim + senior,
  };
}

export function bookLoss(ledger: Ledger, loss: number): Ledger {
  nonnegative(loss);
  if (loss > ledger.assets + 1e-9) throw new RangeError('Loss exceeds the assets in the strategy');
  const assets = Math.max(0, ledger.assets - loss);
  return { ...ledger, assets, seniorClaim: Math.min(ledger.seniorClaim, assets) };
}

/** Assume sufficient settlement-asset liquidity has already been arranged. */
export function settleSenior(ledger: Ledger, shares: number) {
  nonnegative(shares);
  if (shares > ledger.seniorSupply) throw new RangeError('Too many senior shares');
  const escrow = shares * claims(ledger).seniorPrice;
  return {
    escrow,
    ledger: {
      ...ledger,
      assets: ledger.assets - escrow,
      seniorClaim: ledger.seniorClaim - escrow,
      seniorSupply: ledger.seniorSupply - shares,
    },
  };
}

/** The exiting batch bears its sale loss; remaining shares retain their price. */
export function settleJunior(ledger: Ledger, shares: number, requestedSaleLoss: number) {
  nonnegative(shares);
  nonnegative(requestedSaleLoss);
  if (shares > ledger.juniorSupply) throw new RangeError('Too many junior shares');
  const gross = shares * claims(ledger).juniorPrice;
  const saleLoss = Math.min(gross, requestedSaleLoss);
  return {
    gross,
    saleLoss,
    escrow: gross - saleLoss,
    ledger: {
      ...ledger,
      assets: ledger.assets - gross,
      juniorSupply: ledger.juniorSupply - shares,
    },
  };
}

export function accountingExample(step: number, loss = 6) {
  let ledger = initialLedger();
  if (step >= 1) ledger = vestYield(ledger, 8, 4);
  if (step >= 2) ledger = bookLoss(ledger, loss);
  return ledger;
}

export type Lifecycle = 'operating' | 'liquidating' | 'wind-down';
export type MarketCondition = 'normal' | 'restricted' | 'severe';
export const marketConditions: Record<MarketCondition, string> = {
  normal: 'Normal',
  restricted: 'Restricted',
  severe: 'Severe stress',
};

/** Qualitative example only: strategy-specific risk calibration is not modelled. */
export function permissions(condition: MarketCondition, lifecycle: Lifecycle) {
  const operating = lifecycle === 'operating';
  return {
    mint: operating && condition !== 'severe',
    seniorRequest: operating && condition !== 'severe',
    juniorBatch: operating && condition === 'normal',
    remainingClaims: lifecycle === 'wind-down',
    band: marketConditions[condition],
  };
}

export type Scenario = 'mild' | 'redemptions' | 'liquidation';
export const scenarioLabels: Record<Scenario, string> = {
  mild: 'Mild deviation',
  redemptions: 'Redemption under stress',
  liquidation: 'Operator-led unwind',
};

const paths: Record<Scenario, [number, number][]> = {
  mild: [
    [0, 100],
    [15, 97],
    [30, 100],
    [45, 94],
    [65, 98],
    [80, 100],
    [100, 99],
  ],
  redemptions: [
    [0, 100],
    [20, 95],
    [35, 90],
    [55, 90],
    [75, 94],
    [90, 100],
    [100, 100],
  ],
  liquidation: [
    [0, 100],
    [20, 96],
    [35, 100],
    [50, 95],
    [55, 90],
    [60, 90],
    [70, 80],
    [80, 70],
    [100, 70],
  ],
};

export function marketPrice(scenario: Scenario, day: number) {
  const path = paths[scenario];
  const right = path.findIndex(([time]) => time >= day);
  if (right <= 0) return right === 0 ? path[0][1] : path[path.length - 1][1];
  const [start, from] = path[right - 1];
  const [end, to] = path[right];
  return from + ((day - start) / (end - start)) * (to - from);
}

export interface ScenarioPoint {
  day: number;
  market: number;
  senior: number;
  junior: number;
  ledger: Ledger;
  bookedLoss: number;
  lifecycle: Lifecycle;
  note: string;
}

export const scenarioEvents: Record<Scenario, { day: number; label: string }[]> = {
  mild: [
    { day: 0, label: 'Distribution supplied' },
    { day: 45, label: 'Market dip' },
    { day: 60, label: 'Vesting complete' },
  ],
  redemptions: [
    { day: 0, label: 'Distribution supplied' },
    { day: 50, label: 'Senior redemption' },
    { day: 60, label: 'Vesting complete' },
  ],
  liquidation: [
    { day: 0, label: 'Distribution supplied' },
    { day: 55, label: 'Activity restricted' },
    { day: 60, label: 'Operator starts unwind' },
    { day: 70, label: 'First sale booked' },
    { day: 80, label: 'Wind Down' },
  ],
};

/** Invented price indices start at 100; these paths encode no risk thresholds.
 * Yield is a supplied distribution of 16 units (8 per tranche), vesting over
 * 60 days; it then stops. All amounts and event times are illustrative. */
export function buildScenario(scenario: Scenario, juniorCapital = 40): ScenarioPoint[] {
  let ledger = initialLedger(juniorCapital);
  let bookedLoss = 0;
  let lifecycle: Lifecycle = 'operating';
  const points: ScenarioPoint[] = [];
  for (let day = 0; day <= 100; day++) {
    if (day > 0 && day <= 60) ledger = vestYield(ledger, 8 / 60, 8 / 60);
    const market = marketPrice(scenario, day);
    let note =
      day < 60
        ? 'A supplied distribution is vesting. Market movement alone does not change book-value token prices.'
        : 'The supplied distribution has fully vested. Without another distribution, token prices stop accruing yield.';

    if (scenario === 'redemptions' && day === 50) {
      // Sell enough of the underlying to fund a senior payout of 10 units.
      const saleLoss = 10 * (100 / market - 1);
      ledger = bookLoss(ledger, saleLoss);
      const shares = 10 / claims(ledger).seniorPrice;
      ledger = settleSenior(ledger, shares).ledger;
      bookedLoss += saleLoss;
    }
    if (scenario === 'redemptions' && day >= 50) {
      note = `A senior redemption of 10 units required selling the underlying below cost. The realised loss of ${bookedLoss.toFixed(2)} units was booked to junior. ${day < 60 ? 'The remaining supplied yield continues vesting.' : 'Market recovery does not reverse that booked loss.'}`;
    }
    if (scenario === 'liquidation') {
      if (day >= 55 && day < 60)
        note =
          'In this example, worsening market conditions lead to restrictions on new activity. Operations has not initiated liquidation. No risk threshold is modelled.';
      if (day >= 60) {
        lifecycle = 'liquidating';
        note =
          'Operations explicitly starts the irreversible unwind. Supplied yield is now fully vested; the remaining holdings have not yet been sold.';
      }
      // Two illustrative sales each unwind half the original underlying position.
      if (day === 70 || day === 80) {
        const saleLoss = ((100 + juniorCapital) / 2) * (1 - market / 100);
        ledger = bookLoss(ledger, saleLoss);
        bookedLoss += saleLoss;
      }
      if (day >= 70)
        note =
          'Half the underlying position has been sold below cost. Its realised loss is booked; junior absorbs losses first.';
      if (day >= 80) {
        lifecycle = 'wind-down';
        note =
          'The remaining underlying position is sold. Operations completes the unwind and accounting, then enters Wind Down. Remaining claims can be redeemed.';
      }
      if (ledger.seniorClaim < 108 - 1e-8 && day >= 70)
        note += ' Junior is exhausted, so the remaining loss reaches senior.';
    }
    const { seniorPrice, juniorPrice } = claims(ledger);
    points.push({
      day,
      market,
      senior: seniorPrice,
      junior: juniorPrice,
      ledger,
      bookedLoss,
      lifecycle,
      note,
    });
  }
  return points;
}

export const redemptionSteps = [
  {
    label: 'Holding',
    note: 'Two holders each own 10 tokens. Both claims are still part of the strategy.',
  },
  {
    label: 'Queue both',
    note: 'Senior burns 10 shares and fixes 10 units in escrow. Junior queues 10 shares; they remain outstanding and exposed.',
  },
  {
    label: 'Yield vests',
    note: 'Yield of 7.20 units vests to the remaining 90 senior shares; 4 units of yield vests to the 20 junior shares. Queued junior participates. Senior escrow stays fixed.',
  },
  {
    label: 'Book loss',
    note: 'A strategy loss is booked. Queued junior shares participate alongside the other junior shares. The senior escrow is already separate.',
  },
  {
    label: 'Settle junior',
    note: 'Operations settles the batch, burns the queued shares and deducts its sale loss from their claim. The net settlement amount moves to escrow.',
  },
  {
    label: 'Withdraw escrow',
    note: 'Assume the senior cooldown has elapsed. Both holders withdraw their escrow. Strategy assets do not decrease a second time.',
  },
] as const;

export function redemptionExample(step: number, strategyLoss = 6, batchSaleLoss = 1) {
  let ledger = initialLedger();
  let seniorEscrow = 0;
  let juniorEscrow = 0;
  let saleLoss = 0;
  if (step >= 1) {
    const settlement = settleSenior(ledger, 10);
    ledger = settlement.ledger;
    seniorEscrow = settlement.escrow;
  }
  if (step >= 2) ledger = vestYield(ledger, 7.2, 4);
  if (step >= 3) ledger = bookLoss(ledger, strategyLoss);
  if (step >= 4) {
    const settlement = settleJunior(ledger, 10, batchSaleLoss);
    ledger = settlement.ledger;
    juniorEscrow = settlement.escrow;
    saleLoss = settlement.saleLoss;
  }
  const seniorWallet = step >= 5 ? seniorEscrow : 0;
  const juniorWallet = step >= 5 ? juniorEscrow : 0;
  if (step >= 5) seniorEscrow = juniorEscrow = 0;
  const prices = claims(ledger);
  return {
    ledger,
    seniorEscrow,
    juniorEscrow,
    seniorWallet,
    juniorWallet,
    saleLoss,
    seniorTokens: step >= 1 ? 0 : 10,
    juniorTokens: step >= 4 ? 0 : 10,
    seniorExposure: step >= 1 ? 0 : 10 * prices.seniorPrice,
    juniorExposure: step >= 4 ? 0 : 10 * prices.juniorPrice,
  };
}
