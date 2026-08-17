// src/components/LegalPageLayout.tsx
// Shared shell for /privacy and /terms — real, standalone document pages (not modals),
// rendered outside the normal App component tree (see main.tsx) so they're reachable
// with zero dependency on Firebase Auth or any other app state.
import type { ReactNode } from 'react';

type Props = {
  title: string;
  lastUpdated: string;
  children: ReactNode;
};

export default function LegalPageLayout({ title, lastUpdated, children }: Props) {
  return (
    <div className="min-h-screen bg-[#080d1a]">
      <div className="max-w-2xl mx-auto px-6 py-12 md:py-16">
        <a
          href="/"
          className="inline-flex items-center gap-1 text-[#6b849e] hover:text-[#f0f4f8] text-sm font-medium transition-colors mb-8"
        >
          ← Back to NeuroActive
        </a>

        <h1 className="text-3xl md:text-4xl font-extrabold text-[#f0f4f8] mb-2 leading-tight">{title}</h1>
        <p className="text-sm text-[#6b849e] mb-10">Last updated: {lastUpdated}</p>

        <div className="space-y-6">{children}</div>

        <p className="text-sm text-[#6b849e] mt-12 pt-6 border-t border-[#1a2a42]">
          Questions?{' '}
          <a href="mailto:DrB@neuroactivehealth.com" className="text-[#00d4c8] hover:underline">
            DrB@neuroactivehealth.com
          </a>
        </p>
      </div>
    </div>
  );
}

// Shared per-section styling so each legal page's content stays plain JSX (easy to
// diff against the source text) without repeating className strings 19 times.
export function LegalSection({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-bold text-[#f0f4f8] mb-2">
        {number}. {title}
      </h2>
      <div className="space-y-3 text-[#c3d0e0] text-base leading-relaxed">{children}</div>
    </section>
  );
}

export function LegalList({ children }: { children: ReactNode }) {
  return <ul className="list-disc pl-5 space-y-1.5 text-[#c3d0e0] text-base leading-relaxed">{children}</ul>;
}
