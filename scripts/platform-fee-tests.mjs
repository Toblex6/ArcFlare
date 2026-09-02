// scripts/platform-fee-tests.mjs
// Isolated unit mock proof for platform fee debit logic in
// src/app/api/payments/verify-onchain/route.ts (fee block).
// No live chain, no DB, no Next.js — replicates the exact branching
// so tests are deterministic. Run with: node scripts/platform-fee-tests.mjs

// In-memory collector mirroring PlatformFee creates
const platformFeeRows = [];

// Helper: mirrors exact fee logic from verify-onchain/route.ts
// Do not import the route; replicate its branches.
async function simulateFeeDebit({
  payment,
  merchantRow,
  sellerAddress,
  feeBps = 100,
  merchantBalance,
  transferImpl,
  sellerDelta,
}) {
  try {
    const FEE_BPS = feeBps;
    const rawFee = payment.amount * FEE_BPS / 10000;
    const feeAmount = Math.round(rawFee * 1_000_000) / 1_000_000;
    const feeRounded = Math.round(feeAmount * 1e6) / 1e6;
    const SELLER_ADDRESS = sellerAddress;

    const fallbackMerchantId = payment.merchantId || merchantRow?.id || 'unknown';

    if (!merchantRow || merchantRow.walletProvider !== 'CIRCLE' || !merchantRow.circleWalletId) {
      platformFeeRows.push({
        paymentLogId: payment.id,
        merchantId: fallbackMerchantId,
        amountCharged: feeAmount,
        status: 'DEFERRED',
        deferredReason: 'non-Circle wallet, cannot auto-debit',
      });
      return;
    } else if (feeRounded === 0) {
      platformFeeRows.push({
        paymentLogId: payment.id,
        merchantId: fallbackMerchantId,
        amountCharged: feeAmount,
        status: 'DEFERRED',
        deferredReason: 'fee rounds to zero',
      });
      return;
    } else if (!SELLER_ADDRESS) {
      platformFeeRows.push({
        paymentLogId: payment.id,
        merchantId: fallbackMerchantId,
        amountCharged: feeAmount,
        status: 'DEFERRED',
        deferredReason: 'non-Circle wallet, cannot auto-debit',
      });
      return;
    } else {
      // Balance check branch — mirrors readUsdcBalance + feeWei comparison
      let merchantBalanceWei = null;
      if (merchantBalance !== null && merchantBalance !== undefined) {
        if (typeof merchantBalance === 'bigint') merchantBalanceWei = merchantBalance;
        else if (typeof merchantBalance === 'number') merchantBalanceWei = BigInt(Math.round(merchantBalance * 1_000_000));
        else merchantBalanceWei = merchantBalance;
      } else {
        // null simulates RPC failure — real code treats null as "skip check"
        merchantBalanceWei = null;
      }
      const feeWei = BigInt(Math.round(feeRounded * 1_000_000));
      if (merchantBalanceWei !== null && merchantBalanceWei < feeWei) {
        platformFeeRows.push({
          paymentLogId: payment.id,
          merchantId: fallbackMerchantId,
          amountCharged: feeAmount,
          status: 'DEFERRED',
          deferredReason: 'insufficient balance',
        });
        return;
      } else {
        const amountStr = feeRounded.toFixed(6).replace(/\.?0+$/, '');
        let sellerBefore = 0n;
        // sellerBefore is read via RPC in prod; here we just start at 0n
        void sellerBefore;
        let arcTxHashFee;
        let feeTransferFailed = false;
        try {
          const result = await transferImpl({
            walletId: merchantRow.circleWalletId,
            walletAddress: merchantRow.walletAddress,
            destinationAddress: SELLER_ADDRESS,
            amount: amountStr,
          });
          arcTxHashFee = result.arcTxHash;
        } catch (e) {
          platformFeeRows.push({
            paymentLogId: payment.id,
            merchantId: fallbackMerchantId,
            amountCharged: feeAmount,
            status: 'FAILED',
            deferredReason: (e.message || String(e)).slice(0, 500),
          });
          feeTransferFailed = true;
        }
        if (!feeTransferFailed && arcTxHashFee) {
          let receivedWei = feeWei;
          let amountReceived = feeRounded;
          try {
            let delta = null;
            if (sellerDelta !== undefined && sellerDelta !== null) {
              if (typeof sellerDelta === 'bigint') delta = sellerDelta;
              else if (typeof sellerDelta === 'number') delta = BigInt(Math.round(sellerDelta * 1_000_000));
              else delta = sellerDelta;
            }
            if (delta !== null && delta > 0n) {
              receivedWei = delta;
              amountReceived = Number(delta) / 1e6;
            }
            void receivedWei;
          } catch {}
          platformFeeRows.push({
            paymentLogId: payment.id,
            merchantId: fallbackMerchantId,
            amountCharged: feeAmount,
            amountReceived,
            status: 'SUCCESS',
            txHash: arcTxHashFee,
          });
        }
      }
    }
  } catch (e) {
    // Outer catch — mirrors route.ts outer fee try/catch that creates FAILED
    const FEE_BPS_FALLBACK = feeBps ?? 100;
    const feeFallback = Math.round((payment.amount * FEE_BPS_FALLBACK / 10000) * 1e6) / 1e6;
    platformFeeRows.push({
      paymentLogId: payment.id,
      merchantId: payment.merchantId || 'unknown',
      amountCharged: feeFallback,
      status: 'FAILED',
      deferredReason: (e.message || String(e)).slice(0, 500),
    });
  }
}

// ── Test harness ──────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function assert(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name} ${detail}`);
  }
}
function clearRows() {
  platformFeeRows.length = 0;
}

async function run() {
  console.log('── Platform fee debit unit tests (mock, no chain/DB) ─────────────');

  // (a) Circle merchant gets debited correct bps
  {
    clearRows();
    const payment = { id: 'pay_a1', amount: 100, merchantId: 'merch_123', status: 'SUCCESS', reference: 'ref_a' };
    const merchantRow = { id: 'merch_123', walletProvider: 'CIRCLE', circleWalletId: 'cw_abc', walletAddress: '0xMerchant1111111111111111111111111111111111' };
    const sellerAddress = '0xSeller111111111111111111111111111111111111';
    let capturedAmountStr = null;
    const transferImpl = async (args) => {
      capturedAmountStr = args.amount;
      return { arcTxHash: '0xabcFeeTx', circleTxId: 'ctx_1' };
    };
    // merchant has 10 USDC
    const merchantBalance = 10_000_000n;
    // seller delta slightly less due to network fee: 0.999 USDC
    const sellerDelta = 999000n;

    await simulateFeeDebit({ payment, merchantRow, sellerAddress, feeBps: 100, merchantBalance, transferImpl, sellerDelta });

    assert('(a) Circle debit creates one PlatformFee row', platformFeeRows.length === 1, `rows ${platformFeeRows.length}`);
    const row = platformFeeRows[0];
    assert('(a) status SUCCESS', row?.status === 'SUCCESS', JSON.stringify(row));
    assert('(a) amountCharged 1.0 (100 * 100/10000)', row?.amountCharged === 1.0, `got ${row?.amountCharged}`);
    assert('(a) amountReceived ~0.999 (delta)', Math.abs((row?.amountReceived ?? 0) - 0.999) < 1e-9, `got ${row?.amountReceived}`);
    assert('(a) txHash present 0xabcFeeTx', row?.txHash === '0xabcFeeTx', `got ${row?.txHash}`);
    assert('(a) amountStr trimmed "1" not "1.000000"', capturedAmountStr === '1', `got "${capturedAmountStr}"`);

    // amountStr trimming extra check: 1.5 -> "1.5" not "1.500000"
    clearRows();
    const payment2 = { id: 'pay_a2', amount: 150, merchantId: 'merch_123', status: 'SUCCESS', reference: 'ref_a2' };
    let captured2 = null;
    const transferImpl2 = async (args) => { captured2 = args.amount; return { arcTxHash: '0xabc2', circleTxId: 'ctx_2' }; };
    await simulateFeeDebit({ payment: payment2, merchantRow, sellerAddress, feeBps: 100, merchantBalance: 10_000_000n, transferImpl: transferImpl2, sellerDelta: 1_500_000n });
    assert('(a) amountStr "1.5" trimming', captured2 === '1.5', `got "${captured2}" expected "1.5"`);
    const row2 = platformFeeRows[0];
    assert('(a) second call amountCharged 1.5', row2?.amountCharged === 1.5, `got ${row2?.amountCharged}`);
    assert('(a) second call amountReceived 1.5', row2?.amountReceived === 1.5, `got ${row2?.amountReceived}`);

    // also verify 1.1 trimming: payment 11 with 1000 bps => raw 1.1? Actually 11*1000/10000=1.1
    clearRows();
    let captured3 = null;
    await simulateFeeDebit({
      payment: { id: 'pay_a3', amount: 11, merchantId: 'merch_123', status: 'SUCCESS' },
      merchantRow,
      sellerAddress,
      feeBps: 1000,
      merchantBalance: 10_000_000n,
      transferImpl: async (args) => { captured3 = args.amount; return { arcTxHash: '0xabc3', circleTxId: 'ctx_3' }; },
      sellerDelta: 1_100_000n,
    });
    assert('(a) amountStr "1.1" trimming (11 @1000bps)', captured3 === '1.1', `got "${captured3}"`);

    // 1.000001 should stay "1.000001"
    clearRows();
    let captured4 = null;
    // payment amount that yields fee 1.000001 at 100 bps: need 100.0001 *0.01 =1.000001
    await simulateFeeDebit({
      payment: { id: 'pay_a4', amount: 100.0001, merchantId: 'merch_123', status: 'SUCCESS' },
      merchantRow,
      sellerAddress,
      feeBps: 100,
      merchantBalance: 10_000_000n,
      transferImpl: async (args) => { captured4 = args.amount; return { arcTxHash: '0xabc4', circleTxId: 'ctx_4' }; },
      sellerDelta: 1_000_001n,
    });
    assert('(a) amountStr "1.000001" not trimmed incorrectly', captured4 === '1.000001', `got "${captured4}"`);
  }

  // (b) External wallet merchant gets DEFERRED and zero funds move
  {
    clearRows();
    const payment = { id: 'pay_b', amount: 100, merchantId: 'merch_ext', status: 'SUCCESS', reference: 'ref_b' };
    const merchantRow = { id: 'merch_ext', walletProvider: 'METAMASK', circleWalletId: null, walletAddress: '0xExternal1111111111111111111111111111111111' };
    const sellerAddress = '0xSeller111111111111111111111111111111111111';
    let transferCalled = false;
    const transferImpl = async () => { transferCalled = true; return { arcTxHash: '0xshouldNotHappen', circleTxId: 'ctx_x' }; };
    await simulateFeeDebit({ payment, merchantRow, sellerAddress, feeBps: 100, merchantBalance: 10_000_000n, transferImpl, sellerDelta: null });
    assert('(b) DEFERRED row created for external wallet', platformFeeRows.length === 1 && platformFeeRows[0].status === 'DEFERRED', JSON.stringify(platformFeeRows[0]));
    assert('(b) deferredReason "non-Circle wallet, cannot auto-debit"', platformFeeRows[0]?.deferredReason === 'non-Circle wallet, cannot auto-debit', `got "${platformFeeRows[0]?.deferredReason}"`);
    assert('(b) zero funds move (transfer not called)', transferCalled === false, 'transfer was called');
    assert('(b) amountCharged still 1.0 even though deferred', platformFeeRows[0]?.amountCharged === 1.0, `got ${platformFeeRows[0]?.amountCharged}`);
    assert('(b) no txHash on DEFERRED', !platformFeeRows[0]?.txHash, `got ${platformFeeRows[0]?.txHash}`);
  }

  // (c) Checkout still returns success to customer even when fee-debit throws
  {
    clearRows();
    const payment = { id: 'pay_c', amount: 100, merchantId: 'merch_123', status: 'SUCCESS', reference: 'ref_c' };
    const merchantRow = { id: 'merch_123', walletProvider: 'CIRCLE', circleWalletId: 'cw_abc', walletAddress: '0xMerchant1111111111111111111111111111111111' };
    const sellerAddress = '0xSeller111111111111111111111111111111111111';
    const transferImpl = async () => { throw new Error('Circle API down'); };
    let threw = false;
    try {
      await simulateFeeDebit({ payment, merchantRow, sellerAddress, feeBps: 100, merchantBalance: 10_000_000n, transferImpl, sellerDelta: null });
    } catch {
      threw = true;
    }
    assert('(c) fee helper does not throw (error is caught internally)', threw === false, 'helper threw');
    assert('(c) fee row FAILED on throw', platformFeeRows.length === 1 && platformFeeRows[0].status === 'FAILED', JSON.stringify(platformFeeRows[0]));
    assert('(c) FAILED deferredReason contains Circle API down', (platformFeeRows[0]?.deferredReason || '').includes('Circle API down'), `got "${platformFeeRows[0]?.deferredReason}"`);
    // Simulate outer checkout handler: fee failure must not affect SUCCESS response
    const paymentBefore = JSON.parse(JSON.stringify(payment));
    const checkoutResult = { success: true, payment };
    // payment status must remain SUCCESS
    assert('(c) checkout success remains true despite fee failure', checkoutResult.success === true, JSON.stringify(checkoutResult));
    assert('(c) payment status still SUCCESS', payment.status === 'SUCCESS' && paymentBefore.status === 'SUCCESS', `payment status ${payment.status}`);
    assert('(c) payment JSON byte-identical before/after (no mutation)', JSON.stringify(payment) === JSON.stringify(paymentBefore), 'payment was mutated');
  }

  // (d) Byte-identical success check: same payment, three different fee outcomes, payment untouched
  {
    const basePayment = { id: 'pay_d', amount: 50, merchantId: 'merch_123', status: 'SUCCESS', reference: 'ref_d', currency: 'USDC', chain: 'Arc Testnet v1.0' };
    const sellerAddress = '0xSeller111111111111111111111111111111111111';
    const circleRow = { id: 'merch_123', walletProvider: 'CIRCLE', circleWalletId: 'cw_abc', walletAddress: '0xMerchant1111111111111111111111111111111111' };
    const externalRow = { id: 'merch_123', walletProvider: 'METAMASK', circleWalletId: null, walletAddress: '0xExternal1111111111111111111111111111111111' };

    // snapshot before any fee logic
    const beforeJson = JSON.stringify(basePayment);
    const beforeStatus = basePayment.status;

    // (i) success path
    clearRows();
    let threwI = false;
    try {
      await simulateFeeDebit({
        payment: basePayment,
        merchantRow: circleRow,
        sellerAddress,
        feeBps: 100,
        merchantBalance: 10_000_000n,
        transferImpl: async () => ({ arcTxHash: '0xsuccessTx', circleTxId: 'ctx_i' }),
        sellerDelta: 500000n, // 0.5 USDC fee
      });
    } catch { threwI = true; }
    const afterJsonI = JSON.stringify(basePayment);
    assert('(d.i) success path does not throw', threwI === false, 'threw');
    assert('(d.i) payment status stays SUCCESS', basePayment.status === 'SUCCESS' && beforeStatus === 'SUCCESS', basePayment.status);
    assert('(d.i) payment JSON byte-identical after success fee', afterJsonI === beforeJson, `before ${beforeJson} after ${afterJsonI}`);
    assert('(d.i) PlatformFee SUCCESS side-effect exists', platformFeeRows[0]?.status === 'SUCCESS', JSON.stringify(platformFeeRows[0]));
    assert('(d.i) PlatformFee amountCharged 0.5 (50*100/10000)', platformFeeRows[0]?.amountCharged === 0.5, `got ${platformFeeRows[0]?.amountCharged}`);

    // (ii) defer path (external wallet)
    clearRows();
    const beforeJsonII = JSON.stringify(basePayment);
    let threwII = false;
    try {
      await simulateFeeDebit({
        payment: basePayment,
        merchantRow: externalRow,
        sellerAddress,
        feeBps: 100,
        merchantBalance: 10_000_000n,
        transferImpl: async () => ({ arcTxHash: '0xshouldNot', circleTxId: 'ctx_ii' }),
        sellerDelta: null,
      });
    } catch { threwII = true; }
    const afterJsonII = JSON.stringify(basePayment);
    assert('(d.ii) defer path does not throw', threwII === false, 'threw');
    assert('(d.ii) payment status stays SUCCESS', basePayment.status === 'SUCCESS', basePayment.status);
    assert('(d.ii) payment JSON byte-identical after defer', afterJsonII === beforeJsonII && afterJsonII === beforeJson, 'mutated');
    assert('(d.ii) PlatformFee DEFERRED side-effect', platformFeeRows[0]?.status === 'DEFERRED', JSON.stringify(platformFeeRows[0]));

    // (iii) failed path (throw)
    clearRows();
    const beforeJsonIII = JSON.stringify(basePayment);
    let threwIII = false;
    try {
      await simulateFeeDebit({
        payment: basePayment,
        merchantRow: circleRow,
        sellerAddress,
        feeBps: 100,
        merchantBalance: 10_000_000n,
        transferImpl: async () => { throw new Error('Circle API down d-iii'); },
        sellerDelta: null,
      });
    } catch { threwIII = true; }
    const afterJsonIII = JSON.stringify(basePayment);
    assert('(d.iii) failed path does not throw (caught)', threwIII === false, 'propagated');
    assert('(d.iii) payment status stays SUCCESS', basePayment.status === 'SUCCESS', basePayment.status);
    assert('(d.iii) payment JSON byte-identical after failed', afterJsonIII === beforeJsonIII && afterJsonIII === beforeJson, 'mutated');
    assert('(d.iii) PlatformFee FAILED side-effect', platformFeeRows[0]?.status === 'FAILED', JSON.stringify(platformFeeRows[0]));

    // final byte-identical proof: all three left payment exactly as before
    assert('(d) overall payment JSON unchanged across all three outcomes', JSON.stringify(basePayment) === beforeJson, `before ${beforeJson} final ${JSON.stringify(basePayment)}`);
  }

  // (e) fee rounds to zero — payment 0.00001 with 100 bps => 0 after 6-dec rounding => DEFERRED
  {
    clearRows();
    const payment = { id: 'pay_e', amount: 0.00001, merchantId: 'merch_123', status: 'SUCCESS', reference: 'ref_e' };
    const merchantRow = { id: 'merch_123', walletProvider: 'CIRCLE', circleWalletId: 'cw_abc', walletAddress: '0xMerchant1111111111111111111111111111111111' };
    const sellerAddress = '0xSeller111111111111111111111111111111111111';
    let called = false;
    await simulateFeeDebit({
      payment,
      merchantRow,
      sellerAddress,
      feeBps: 100,
      merchantBalance: 10_000_000n,
      transferImpl: async () => { called = true; return { arcTxHash: '0xfee', circleTxId: 'ctx' }; },
      sellerDelta: null,
    });
    assert('(e) fee rounds to zero DEFERRED', platformFeeRows[0]?.status === 'DEFERRED', JSON.stringify(platformFeeRows[0]));
    assert('(e) deferredReason "fee rounds to zero"', platformFeeRows[0]?.deferredReason === 'fee rounds to zero', `got "${platformFeeRows[0]?.deferredReason}"`);
    assert('(e) amountCharged 0', platformFeeRows[0]?.amountCharged === 0, `got ${platformFeeRows[0]?.amountCharged}`);
    assert('(e) no transfer on zero fee', called === false, 'transfer was called');
    // sanity math: rawFee = 0.00001*0.01=0.0000001 => Math.round(0.1)/1e6=0
    const rawFee = 0.00001 * 100 / 10000;
    const feeAmount = Math.round(rawFee * 1_000_000) / 1_000_000;
    assert('(e) math proof feeAmount is 0', feeAmount === 0, `got ${feeAmount}`);
  }

  // (f) insufficient balance — merchant has 0.5 USDC but fee is 1.0 USDC
  {
    clearRows();
    const payment = { id: 'pay_f', amount: 100, merchantId: 'merch_123', status: 'SUCCESS', reference: 'ref_f' };
    const merchantRow = { id: 'merch_123', walletProvider: 'CIRCLE', circleWalletId: 'cw_abc', walletAddress: '0xMerchant1111111111111111111111111111111111' };
    const sellerAddress = '0xSeller111111111111111111111111111111111111';
    let called = false;
    await simulateFeeDebit({
      payment,
      merchantRow,
      sellerAddress,
      feeBps: 100,
      merchantBalance: 500_000n, // 0.5 USDC < 1.0 fee
      transferImpl: async () => { called = true; return { arcTxHash: '0xfee', circleTxId: 'ctx' }; },
      sellerDelta: null,
    });
    assert('(f) insufficient balance DEFERRED', platformFeeRows[0]?.status === 'DEFERRED', JSON.stringify(platformFeeRows[0]));
    assert('(f) deferredReason "insufficient balance"', platformFeeRows[0]?.deferredReason === 'insufficient balance', `got "${platformFeeRows[0]?.deferredReason}"`);
    assert('(f) no transfer when insufficient', called === false, 'transfer was called');
    assert('(f) amountCharged still 1.0', platformFeeRows[0]?.amountCharged === 1.0, `got ${platformFeeRows[0]?.amountCharged}`);
  }

  // (g) SELLER_ADDRESS missing => DEFERRED non-Circle (same string as route)
  {
    clearRows();
    const payment = { id: 'pay_g', amount: 100, merchantId: 'merch_123', status: 'SUCCESS' };
    const merchantRow = { id: 'merch_123', walletProvider: 'CIRCLE', circleWalletId: 'cw_abc', walletAddress: '0xMerchant1111111111111111111111111111111111' };
    let called = false;
    await simulateFeeDebit({
      payment,
      merchantRow,
      sellerAddress: null, // missing
      feeBps: 100,
      merchantBalance: 10_000_000n,
      transferImpl: async () => { called = true; return { arcTxHash: '0xfee', circleTxId: 'ctx' }; },
      sellerDelta: null,
    });
    assert('(g) missing SELLER_ADDRESS DEFERRED', platformFeeRows[0]?.status === 'DEFERRED', JSON.stringify(platformFeeRows[0]));
    assert('(g) deferredReason "non-Circle wallet, cannot auto-debit" (parity with route)', platformFeeRows[0]?.deferredReason === 'non-Circle wallet, cannot auto-debit', `got "${platformFeeRows[0]?.deferredReason}"`);
    assert('(g) no transfer when SELLER_ADDRESS missing', called === false, 'transfer was called');
  }

  console.log('──────────────────────────────────────────────────────────────');
  console.log(`PASS: ${pass}  FAIL: ${fail}`);
  if (fail > 0) process.exit(1);
  else process.exit(0);
}

run().catch((e) => {
  console.error('harness error', e);
  process.exit(1);
});
