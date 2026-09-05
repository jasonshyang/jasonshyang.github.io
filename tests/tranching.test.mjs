import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accountingExample,
  initialLedger,
  claims,
  vestYield,
  bookLoss,
  settleSenior,
  settleJunior,
  permissions,
  buildScenario,
  redemptionExample,
} from '../src/lib/tranching/model.ts';
import { linePath, position } from '../src/lib/interactive/chart.ts';

const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const valid = (ledger) => {
  const values = claims(ledger);
  for (const value of Object.values({ ...ledger, ...values }))
    assert.ok(Number.isFinite(value) && value >= -1e-9);
  near(ledger.seniorClaim + values.juniorClaim, ledger.assets);
  near(values.seniorPrice * ledger.seniorSupply, ledger.seniorClaim);
  near(values.juniorPrice * ledger.juniorSupply, values.juniorClaim);
};

test('the article’s example: vested yield followed by a loss of 6 units', () => {
  near(claims(accountingExample(0)).seniorPrice, 1);
  near(claims(accountingExample(0)).juniorPrice, 1);
  near(claims(accountingExample(1)).seniorPrice, 1.08);
  near(claims(accountingExample(1)).juniorPrice, 1.2);
  const result = accountingExample(2, 6);
  near(result.assets, 126);
  near(result.seniorClaim, 108);
  near(claims(result).juniorPrice, 0.9);
});

test('junior is exactly exhausted at 24; further losses impair senior', () => {
  const boundary = accountingExample(2, 24);
  near(claims(boundary).juniorPrice, 0);
  near(boundary.seniorClaim, 108);
  near(accountingExample(2, 25).seniorClaim, 107);
  near(accountingExample(2, 132).assets, 0);
  for (let loss = 0; loss <= 132; loss++) valid(accountingExample(2, loss));
});

test('losses and distributions cannot manufacture negative assets', () => {
  for (const bad of [-1, Infinity, NaN]) {
    assert.throws(() => bookLoss(initialLedger(), bad), RangeError);
    assert.throws(() => vestYield(initialLedger(), bad, 0), RangeError);
  }
  assert.throws(() => bookLoss(initialLedger(), 121), RangeError);
});

test('qualitative risk conditions restrict actions independently of lifecycle', () => {
  const expected = {
    normal: { mint: true, seniorRequest: true, juniorBatch: true },
    restricted: { mint: true, seniorRequest: true, juniorBatch: false },
    severe: { mint: false, seniorRequest: false, juniorBatch: false },
  };
  for (const [condition, actions] of Object.entries(expected)) {
    const allowed = permissions(condition, 'operating');
    for (const [action, enabled] of Object.entries(actions)) assert.equal(allowed[action], enabled);
    assert.equal(allowed.remainingClaims, false);
  }
});

test('a market recovery cannot reopen liquidation or wind-down', () => {
  for (const key of ['mint', 'seniorRequest', 'juniorBatch']) {
    assert.equal(permissions('normal', 'liquidating')[key], false);
    assert.equal(permissions('normal', 'wind-down')[key], false);
  }
  assert.equal(permissions('severe', 'wind-down').remainingClaims, true);
});

test('market price moves alone do not book losses or create yield', () => {
  const mild = buildScenario('mild');
  assert.equal(mild[45].market, 94);
  near(mild[45].senior, 1.06);
  near(mild[45].junior, 1.15);
  near(mild[100].bookedLoss, 0);
  near(mild[60].senior, mild[100].senior);
  near(mild[60].junior, mild[100].junior);
});

test('a senior redemption funds the payout and books its sale loss without changing senior price', () => {
  const points = buildScenario('redemptions');
  const normal = buildScenario('mild');
  near(points[50].bookedLoss, 10 * (100 / 90 - 1));
  near(points[50].senior, normal[50].senior);
  assert.ok(points[50].junior < points[49].junior);
  assert.ok(points[50].ledger.seniorSupply < 100);
  near(points[100].ledger.assets, 156 - 10 - points[100].bookedLoss);
});

test('operator-led unwind is separate from market stress; sale prices determine losses', () => {
  const points = buildScenario('liquidation');
  assert.equal(points[55].market, 90);
  assert.equal(points[55].lifecycle, 'operating');
  assert.equal(points[60].lifecycle, 'liquidating');
  near(points[69].bookedLoss, 0);
  near(points[70].bookedLoss, 70 * 0.2);
  near(points[80].bookedLoss, 70 * 0.2 + 70 * 0.3);
  assert.equal(points[80].lifecycle, 'wind-down');
  near(points[100].senior, 1.08);
  assert.ok(points[100].junior > 0);
  assert.ok(buildScenario('liquidation', 5)[100].senior < 1);
});

test('all scenario capital mixes conserve the ledger and never produce negative claims', () => {
  for (const scenario of ['mild', 'redemptions', 'liquidation']) {
    for (let capital = 5; capital <= 60; capital += 5) {
      for (const point of buildScenario(scenario, capital)) valid(point.ledger);
    }
  }
});

test('senior settlement burns shares at the current price and removes escrow once', () => {
  const ledger = vestYield(initialLedger(), 8, 4);
  const result = settleSenior(ledger, 10);
  near(result.escrow, 10.8);
  near(result.ledger.assets + result.escrow, ledger.assets);
  near(claims(result.ledger).seniorPrice, claims(ledger).seniorPrice);
  near(claims(result.ledger).juniorPrice, claims(ledger).juniorPrice);
  assert.throws(() => settleSenior(ledger, 101), RangeError);
});

test('the junior batch pays its own exit loss while remaining shares retain their price', () => {
  const ledger = accountingExample(2, 6);
  const result = settleJunior(ledger, 10, 1);
  near(result.gross, 9);
  near(result.escrow, 8);
  near(result.ledger.assets + result.escrow + result.saleLoss, ledger.assets);
  near(claims(result.ledger).juniorPrice, 0.9);
  near(settleJunior(ledger, 10, 100).escrow, 0);
  assert.throws(() => settleJunior(ledger, 21, 0), RangeError);
});

test('queued junior keeps exposure; senior escrow stays fixed; withdrawal does not debit strategy twice', () => {
  near(redemptionExample(1).seniorEscrow, 10);
  near(redemptionExample(2).seniorEscrow, 10);
  near(redemptionExample(2).juniorExposure, 12);
  near(redemptionExample(3).juniorExposure, 9);
  const settled = redemptionExample(4);
  const withdrawn = redemptionExample(5);
  near(settled.juniorEscrow, 8);
  near(settled.ledger.assets, 106.2);
  assert.deepEqual(settled.ledger, withdrawn.ledger);
  near(withdrawn.seniorWallet, 10);
  near(withdrawn.juniorWallet, 8);
  near(withdrawn.seniorEscrow + withdrawn.juniorEscrow, 0);
});

test('all redemption loss settings preserve a nonnegative, balanced ledger', () => {
  for (let loss = 0; loss <= 24; loss++) {
    for (let batchLoss = 0; batchLoss <= 10; batchLoss++) {
      for (let step = 0; step <= 5; step++) valid(redemptionExample(step, loss, batchLoss).ledger);
    }
  }
});

test('SVG plots retain discontinuities and map independent units to the same timeline', () => {
  const plot = { width: 640, height: 200, xMin: 0, xMax: 100, yMin: 0, yMax: 2 };
  const points = [
    { x: 0, y: 1 },
    { x: 50, y: 0.5 },
  ];
  assert.match(linePath(points, plot, true), /^M[\d.,]+ H[\d.]+V[\d.]+$/);
  near(
    position({ x: 50, y: 1 }, plot).x,
    position({ x: 50, y: 90 }, { ...plot, yMin: 70, yMax: 110 }).x,
  );
});
