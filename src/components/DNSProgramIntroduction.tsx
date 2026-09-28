import { ArrowLeft, Brain, Layers3, Network, Sprout, User } from 'lucide-react';
import { PROGRAM_DISPLAY_PRICE } from '../services/stripe';

type Props = {
  onBack: () => void;
  onContinue: () => void;
  onOpenSettings: () => void;
};

// "$149" derived from "$149 USD" (see services/stripe.ts) rather than hardcoded a second
// time — Stripe's configured price remains the single source of truth for the amount.
const CTA_PRICE = PROGRAM_DISPLAY_PRICE.split(' ')[0];

// Primary CTA, rendered once near the top (visible without scrolling) and again at the
// bottom — both instances call the same onContinue (advance to Paywall), so there is
// exactly one path into checkout from this page, just reachable from two places.
function StartCta({ onContinue }: { onContinue: () => void }) {
  return (
    // Capped to max-w-md — matching Paywall's (~464px) and the landing page's (448px)
    // primary-CTA width — rather than stretching to this page's full max-w-2xl prose
    // column (~624px). Same two-stop gradient, same colors, same opacity everywhere; a
    // 2-stop 135deg gradient scales proportionally, so a ~35% wider box pushes ~35% more
    // of the visibly-blended teal→purple midtone under the button's own centered text —
    // exactly where a reader's eye lands — while a 2px-wider or -narrower box barely
    // matters. That's what read as "dark/washed out" on this page while the same gradient
    // read as vivid on Paywall/Landing: those buttons are already narrow enough that the
    // text sits close to the saturated teal edge. Matching the width matches the read.
    <div className="mx-auto max-w-md text-center">
      <button
        onClick={onContinue}
        className="w-full rounded-xl py-4 text-base font-bold text-[#080d1a] transition-all hover:opacity-90 active:scale-95"
        style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
      >
        Start DNS Foundations — {CTA_PRICE}
      </button>
      <p className="mt-3 text-xs text-[#6b849e]">Have a promotional code? Enter it during secure checkout.</p>
    </div>
  );
}

export default function DNSProgramIntroduction({ onBack, onContinue, onOpenSettings }: Props) {
  return (
    <div className="min-h-screen bg-[#080d1a] pb-20 overflow-hidden">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-[#1a2a42] bg-[#080d1a]/90 px-4 py-4 backdrop-blur-md">
        <button onClick={onBack} className="flex items-center gap-1 text-sm text-[#6b849e] transition-colors hover:text-[#f0f4f8]">
          <ArrowLeft size={18} /> Back
        </button>
        <span className="text-sm font-semibold text-[#f0f4f8]">DNS Foundations</span>
        <button onClick={onOpenSettings} className="rounded-full bg-[#1a2a42] p-2 transition-opacity hover:opacity-80" aria-label="Profile & Settings">
          <User size={18} className="text-[#6b849e]" />
        </button>
      </header>

      <main className="relative mx-auto max-w-2xl space-y-10 px-6 py-12">
        <div className="pointer-events-none absolute left-1/2 top-0 h-80 w-80 -translate-x-1/2 rounded-full bg-[#00d4c8]/10 blur-3xl" />

        <section className="relative py-8 text-center">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl border border-[#00d4c8]/30 bg-[#00d4c8]/10">
            <Brain size={32} className="text-[#00d4c8]" />
          </div>
          <h1 className="text-4xl font-extrabold leading-tight text-[#f0f4f8] md:text-5xl">
            Your brain already has the blueprint.
          </h1>
          <p className="mt-3 text-2xl font-bold text-[#00d4c8]">Let&apos;s build from it.</p>
        </section>

        {/* Top CTA — reachable without scrolling, so a motivated visitor never has to
            read the rest of this page before starting. */}
        <StartCta onContinue={onContinue} />

        <section className="space-y-4 text-base leading-relaxed text-[#c3d0e0]">
          <p>Over 12 weeks, you&apos;ll learn a different way to use your body:</p>
          <ul className="space-y-2 list-disc list-inside marker:text-[#00d4c8]">
            <li>
              <strong className="text-[#f0f4f8]">Create stability</strong> without simply bracing harder.
            </li>
            <li>
              <strong className="text-[#f0f4f8]">Control movement</strong>, instead of just completing it.
            </li>
            <li>
              <strong className="text-[#f0f4f8]">Carry that control</strong> into increasingly demanding positions.
            </li>
          </ul>
          <p>But the goal isn&apos;t to spend the rest of your life thinking about how you&apos;re moving.</p>
        </section>

        <section className="relative overflow-hidden rounded-3xl border border-[#7c5cfc]/30 bg-gradient-to-br from-[#7c5cfc]/15 to-[#00d4c8]/10 p-7 md:p-9">
          <Sprout size={30} className="mb-5 text-[#00d4c8]" />
          <h2 className="text-2xl font-extrabold text-[#f0f4f8]">Plant the seed. Let your brain do the hard part.</h2>
          <p className="mt-5 leading-relaxed text-[#c3d0e0]">
            Give your brain the right experience and reinforce it a little each day —{' '}
            <strong className="text-[#f0f4f8]">your brain does the rest.</strong>
          </p>
          <p className="mt-4 leading-relaxed text-[#c3d0e0]">
            Practice matters. Precision matters. But mastering the exercises isn&apos;t the destination. The goal is
            to use them to change what your body does when you&apos;re not thinking about it.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-extrabold text-[#f0f4f8]">We start foundational on purpose.</h2>
          <p className="mt-4 leading-relaxed text-[#c3d0e0]">
            First, we lay the groundwork. Then we build the structure. Later, we wire it all together — week by
            week, new positions and new challenges ask your body to stabilize, coordinate, and move in
            increasingly complex ways.
          </p>

          <div className="mt-8 grid gap-3 md:grid-cols-3">
            {[
              { icon: Layers3, step: '01', label: 'Groundwork', detail: 'Breathing, pressure, stability, and control' },
              { icon: Sprout, step: '02', label: 'Structure', detail: 'Then we build the structure.' },
              { icon: Network, step: '03', label: 'Wiring', detail: 'Later, we wire it all together.' },
            ].map(({ icon: Icon, step, label, detail }) => (
              <div key={label} className="rounded-2xl border border-[#1a2a42] bg-[#0f1829] p-5">
                <div className="mb-5 flex items-center justify-between">
                  <Icon size={22} className="text-[#00d4c8]" />
                  <span className="text-xs font-bold text-[#7c5cfc]">{step}</span>
                </div>
                <p className="font-bold text-[#f0f4f8]">{label}</p>
                <p className="mt-2 text-xs leading-relaxed text-[#6b849e]">{detail}</p>
              </div>
            ))}
          </div>

          <div className="mt-8 space-y-3 leading-relaxed text-[#c3d0e0]">
            <p>
              <strong className="text-[#f0f4f8]">Nothing is random.</strong> Every new challenge is built on
              something you&apos;ve already learned.
            </p>
            <p>By Week 12, you&apos;ll be solving movement problems that would have made very little sense to start with on Day 1.</p>
          </div>
        </section>

        <section className="border-t border-[#1a2a42] pt-10 text-center">
          <p className="mb-7 text-2xl font-extrabold text-[#f0f4f8]">Better movement is already in the blueprint.</p>
          <StartCta onContinue={onContinue} />
        </section>
      </main>
    </div>
  );
}
