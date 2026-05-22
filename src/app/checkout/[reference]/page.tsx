"use client";

import Image from "next/image";

import {
  ConnectButton,
} from "@rainbow-me/rainbowkit";

import {
  useAccount,
  useSendTransaction,
  useChainId,
} from "wagmi";

import {
  parseEther,
} from "viem";

export default function CheckoutPage() {

  const {
    isConnected,
    address,
  } = useAccount();

  const chainId =
    useChainId();

  const {
    sendTransaction,
    isPending,
  } = useSendTransaction();

  const handlePayment =
    async () => {

      try {

        console.log(
          "Starting ArcFlare Payment"
        );

        console.log(
          "Wallet Address:",
          address
        );

        console.log(
          "Source Chain:",
          chainId
        );

        /*
          FUTURE INFRASTRUCTURE:
          - Circle CCTP
          - Arc settlement routing
          - Webhook verification
          - Merchant settlement
        */

        sendTransaction({

          to: "0x000000000000000000000000000000000000dead",

          value: parseEther("0.001"),
        });

      } catch (error) {

        console.log(error);
      }
    };

  return (

    <main className="min-h-screen bg-[#120b08] text-white px-6 py-10">

      {/* HEADER */}

      <div className="max-w-6xl mx-auto flex items-center justify-between mb-12">

        <div className="flex items-center gap-4">

          <Image
            src="/arcflare-logo.png"
            alt="ArcFlare Logo"
            width={55}
            height={55}
            priority
            className="object-contain"
          />

          <div>

            <h1 className="text-3xl font-bold tracking-wide">
              ArcFlare
            </h1>

            <p className="text-cyan-300 text-sm">
              Stablecoin Payment Infrastructure
            </p>

          </div>

        </div>

        <ConnectButton />

      </div>

      {/* MAIN SECTION */}

      <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-10">

        {/* LEFT PANEL */}

        <div className="bg-[#1f140f] border border-[#3a2a20] rounded-3xl p-8 shadow-2xl">

          <div className="mb-8">

            <p className="text-cyan-300 uppercase text-sm tracking-widest mb-2">

              Hosted Checkout

            </p>

            <h2 className="text-4xl font-bold leading-tight">

              Seamless Stablecoin
              Payments on Arc

            </h2>

          </div>

          <div className="space-y-5">

            {/* MERCHANT */}

            <div className="bg-[#2a1c15] rounded-2xl p-5 border border-[#493328]">

              <div className="flex justify-between items-center">

                <span className="text-gray-400">
                  Merchant
                </span>

                <span className="font-semibold">
                  ArcFlare Demo
                </span>

              </div>

            </div>

            {/* AMOUNT */}

            <div className="bg-[#2a1c15] rounded-2xl p-5 border border-[#493328]">

              <div className="flex justify-between items-center">

                <span className="text-gray-400">
                  Amount
                </span>

                <span className="font-semibold text-2xl">
                  50 USDC
                </span>

              </div>

            </div>

            {/* NETWORK */}

            <div className="bg-[#2a1c15] rounded-2xl p-5 border border-[#493328]">

              <div className="flex justify-between items-center">

                <span className="text-gray-400">
                  Settlement Network
                </span>

                <span className="font-semibold text-cyan-300">
                  Arc Testnet
                </span>

              </div>

            </div>

            {/* CHAIN DETECTION */}

            <div className="bg-[#2a1c15] rounded-2xl p-5 border border-[#493328]">

              <div className="flex justify-between items-center">

                <span className="text-gray-400">
                  Source Chain ID
                </span>

                <span className="font-semibold text-cyan-300">

                  {chainId}

                </span>

              </div>

            </div>

            {/* WALLET */}

            <div className="bg-[#2a1c15] rounded-2xl p-5 border border-[#493328]">

              <div className="flex flex-col gap-3">

                <span className="text-gray-400">
                  Connected Wallet
                </span>

                <span className="font-semibold break-all text-sm">

                  {address
                    ? address
                    : "No wallet connected"}

                </span>

              </div>

            </div>

          </div>

          {/* PAYMENT BUTTON */}

          <div className="mt-10">

            {isConnected ? (

              <button
                onClick={handlePayment}
                disabled={isPending}
                className="w-full bg-cyan-400 hover:bg-cyan-300 transition-all text-black font-bold py-4 rounded-2xl text-lg"
              >

                {isPending
                  ? "Processing..."
                  : "Pay with USDC"}

              </button>

            ) : (

              <div className="bg-[#2a1c15] border border-[#493328] rounded-2xl p-6 text-center">

                <p className="text-gray-300 mb-4">

                  Connect your wallet to continue

                </p>

                <ConnectButton />

              </div>

            )}

          </div>

        </div>

        {/* RIGHT PANEL */}

        <div className="bg-[#1f140f] border border-[#3a2a20] rounded-3xl p-8 shadow-2xl">

          <h3 className="text-2xl font-bold mb-8">

            Payment Analytics

          </h3>

          {/* STATS */}

          <div className="grid grid-cols-2 gap-5 mb-8">

            <div className="bg-[#2a1c15] p-6 rounded-2xl border border-[#493328]">

              <p className="text-gray-400 text-sm mb-2">

                Total Volume

              </p>

              <h2 className="text-3xl font-bold">
                $24.8K
              </h2>

            </div>

            <div className="bg-[#2a1c15] p-6 rounded-2xl border border-[#493328]">

              <p className="text-gray-400 text-sm mb-2">

                Transactions

              </p>

              <h2 className="text-3xl font-bold">
                1,248
              </h2>

            </div>

          </div>

          {/* SUCCESS RATE */}

          <div className="bg-[#2a1c15] rounded-2xl p-6 border border-[#493328] mb-6">

            <div className="flex justify-between mb-4">

              <span className="text-gray-400">
                Success Rate
              </span>

              <span className="text-cyan-300 font-bold">
                98.2%
              </span>

            </div>

            <div className="w-full h-3 bg-[#120b08] rounded-full overflow-hidden">

              <div className="w-[98%] h-full bg-cyan-400 rounded-full"></div>

            </div>

          </div>

          {/* TRANSACTIONS */}

          <div className="bg-[#2a1c15] rounded-2xl p-6 border border-[#493328]">

            <h4 className="text-lg font-semibold mb-5">

              Recent Transactions

            </h4>

            <div className="space-y-4">

              <div className="flex justify-between">

                <span className="text-gray-400">
                  Payment #2048
                </span>

                <span className="text-cyan-300">
                  Success
                </span>

              </div>

              <div className="flex justify-between">

                <span className="text-gray-400">
                  Payment #2047
                </span>

                <span className="text-cyan-300">
                  Success
                </span>

              </div>

              <div className="flex justify-between">

                <span className="text-gray-400">
                  Payment #2046
                </span>

                <span className="text-yellow-300">
                  Pending
                </span>

              </div>

            </div>

          </div>

          {/* ARC SETTLEMENT */}

          <div className="mt-8 bg-[#120b08] rounded-2xl p-5 border border-cyan-400/20">

            <div className="flex justify-between items-center mb-3">

              <p className="text-gray-400">
                Arc Settlement Engine
              </p>

              <p className="text-cyan-300">
                Active
              </p>

            </div>

            <p className="text-sm text-gray-500 leading-relaxed">

              ArcFlare is building
              programmable stablecoin
              settlement infrastructure
              on Arc with future support
              for Circle CCTP cross-chain
              settlement flows.

            </p>

          </div>

        </div>

      </div>

    </main>
  );
}