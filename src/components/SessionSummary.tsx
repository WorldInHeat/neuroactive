import type { DecisionNode } from '../state/types';

type Props = {
  nodeId: string;
  prescriptions: string[];
  painDrawingData: Record<string, number> | null;
  onDone: () => void;
  decisionTree: Record<string, DecisionNode>;
};

function classify(prescriptions: string[]): string {
  const hasMdt = prescriptions.some(id => id.includes('mdt'));
  const hasDns = prescriptions.some(id => id.includes('dns'));
  if (hasMdt && hasDns) return 'MDT + DNS Protocol';
  if (hasMdt) return 'MDT Responder';
  if (hasDns) return 'DNS Foundation';
  return 'Movement Protocol';
}

export default function SessionSummary({ prescriptions, painDrawingData, onDone, decisionTree }: Props) {
  const classification = classify(prescriptions);
  // Hard rule, independent of any caller's premium check: this component must never
  // print the full text/description/frequency of a premium node, under any circumstance.
  const prescriptionNodes = prescriptions
    .map(id => decisionTree[id])
    .filter((n): n is DecisionNode => !!n && !n.isPremium);

  const painRegions = painDrawingData ? Object.keys(painDrawingData) : [];

  return (
    <div className="min-h-screen bg-[#080d1a] pb-24">
      {/* Header */}
      <div className="bg-[#0f1829] border-b border-[#1a2a42] px-4 py-4 flex items-center justify-center">
        <span className="font-semibold text-[#f0f4f8]">Session Summary</span>
      </div>

      <div className="max-w-2xl mx-auto px-4 pt-8 space-y-5">

        {/* Checkmark hero */}
        <div className="text-center">
          <div
            className="inline-flex items-center justify-center w-16 h-16 rounded-full mb-4"
            style={{ background: 'rgba(0,212,200,0.12)', border: '2px solid rgba(0,212,200,0.4)' }}
          >
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <path d="M5 14L11 20L23 8" stroke="#00d4c8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-[#f0f4f8]">Assessment Complete</h1>
          <p className="text-[#6b849e] text-sm mt-1">Here's your personalised plan based on today's assessment.</p>
        </div>

        {/* Classification card */}
        <div
          className="rounded-2xl p-5"
          style={{ background: 'linear-gradient(135deg, rgba(0,212,200,0.08), rgba(124,92,252,0.08))', border: '1px solid rgba(0,212,200,0.25)' }}
        >
          <p className="text-xs font-bold uppercase tracking-widest text-[#00d4c8] mb-1">Classification</p>
          <p className="text-xl font-bold text-[#f0f4f8]">{classification}</p>
          {painRegions.length > 0 && (
            <p className="text-sm text-[#6b849e] mt-1">
              Reported regions: {painRegions.join(', ')}
            </p>
          )}
        </div>

        {/* Prescription list */}
        {prescriptionNodes.length > 0 && (
          <div>
            <h2 className="text-sm font-bold uppercase tracking-widest text-[#6b849e] mb-3">Your Exercises</h2>
            <div className="space-y-3">
              {prescriptionNodes.map(node => (
                <div
                  key={node.id}
                  className="rounded-xl p-4"
                  style={{ background: '#0f1829', border: '1px solid rgba(0,212,200,0.2)' }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-[#f0f4f8] text-sm">{node.text}</p>
                      {node.description && (
                        <p className="text-xs text-[#6b849e] mt-1 leading-relaxed">{node.description}</p>
                      )}
                    </div>
                    {node.prescriptionFrequency && (
                      <span
                        className="text-xs font-bold px-2 py-1 rounded-lg flex-shrink-0"
                        style={{ background: 'rgba(0,212,200,0.1)', color: '#00d4c8', border: '1px solid rgba(0,212,200,0.2)' }}
                      >
                        {node.prescriptionFrequency}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Your Plan */}
        <div className="rounded-2xl p-5" style={{ background: '#0f1829', border: '1px solid #1a2a42' }}>
          <h2 className="text-sm font-bold uppercase tracking-widest text-[#6b849e] mb-3">Your Plan</h2>
          <div className="space-y-3">
            <div className="flex gap-3">
              <div
                className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
                style={{ background: 'rgba(0,212,200,0.12)', color: '#00d4c8' }}
              >
                1
              </div>
              <div>
                <p className="text-sm font-semibold text-[#f0f4f8]">Do your exercises consistently</p>
                <p className="text-xs text-[#6b849e] mt-0.5">
                  {prescriptionNodes[0]?.prescriptionFrequency
                    ? `Aim for ${prescriptionNodes[0].prescriptionFrequency}`
                    : 'Follow the frequency shown for each exercise'}
                </p>
              </div>
            </div>
            <div className="flex gap-3">
              <div
                className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
                style={{ background: 'rgba(124,92,252,0.12)', color: '#7c5cfc' }}
              >
                2
              </div>
              <div>
                <p className="text-sm font-semibold text-[#f0f4f8]">Log your pain daily</p>
                <p className="text-xs text-[#6b849e] mt-0.5">Track progress from the dashboard check-in</p>
              </div>
            </div>
            <div className="flex gap-3">
              <div
                className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold"
                style={{ background: 'rgba(0,212,200,0.12)', color: '#00d4c8' }}
              >
                3
              </div>
              <div>
                <p className="text-sm font-semibold text-[#f0f4f8]">Reassess in 24–48 hours</p>
                <p className="text-xs text-[#6b849e] mt-0.5">Return to assessment if symptoms change or don't improve</p>
              </div>
            </div>
          </div>
        </div>

        {/* CTA */}
        <button
          onClick={onDone}
          className="w-full py-4 rounded-xl font-bold text-[#080d1a] text-base"
          style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
        >
          Go to Dashboard
        </button>
      </div>
    </div>
  );
}
