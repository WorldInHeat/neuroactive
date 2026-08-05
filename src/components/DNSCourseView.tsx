// src/components/DNSCourseView.tsx
// 12-Week DNS Foundations course. Structurally separate from DECISION_TREE —
// does not touch activePrescriptions, history, or any assessment-flow state.
import { useEffect } from 'react';
import type { Auth } from 'firebase/auth';
import { ArrowLeft, CheckCircle, Lock } from 'lucide-react';
import { DNS_COURSE } from '../data/dnsCourse';
import type { DnsCourseProgress } from '../state/types';
import type { PriceKey } from '../services/stripe';
import VideoPlayer from './VideoPlayer';
import Paywall from './Paywall';

type Props = {
  dnsCourse: DnsCourseProgress;
  onUpdateDnsCourse: (updates: Partial<DnsCourseProgress>) => void;
  today: string; // local calendar date, e.g. from todayLocalISO()
  isPremium: boolean;
  onBack: () => void;
  auth: Auth | null;
  checkoutLoading: PriceKey | null;
  setCheckoutLoading: (key: PriceKey | null) => void;
};

export default function DNSCourseView({
  dnsCourse,
  onUpdateDnsCourse,
  today,
  isPremium,
  onBack,
  auth,
  checkoutLoading,
  setCheckoutLoading,
}: Props) {
  const currentDayData = DNS_COURSE[dnsCourse.currentDay - 1];

  // startedAt is set once, the first time the course is opened
  useEffect(() => {
    if (!dnsCourse.startedAt) {
      onUpdateDnsCourse({ startedAt: today });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!currentDayData) {
    return (
      <div className="min-h-screen bg-[#080d1a] p-6">
        <div className="max-w-2xl mx-auto bg-[#0f1829] p-6 rounded-xl border border-[#1a2a42]">
          <h2 className="text-xl font-bold text-[#f0f4f8]">Course Complete</h2>
          <p className="text-[#6b849e] mt-2">You've completed all 84 days of the DNS Foundations program.</p>
          <button
            onClick={onBack}
            className="mt-4 px-4 py-2 rounded-lg font-semibold text-[#080d1a]"
            style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
          >
            Back to Dashboard
          </button>
        </div>
      </div>
    );
  }

  if (currentDayData.isPremium && !isPremium) {
    return <Paywall auth={auth} checkoutLoading={checkoutLoading} setCheckoutLoading={setCheckoutLoading} onBack={onBack} />;
  }

  const isSameDayAlreadyCompleted = dnsCourse.lastCompletedDate === today;
  const nextDayData = DNS_COURSE[dnsCourse.currentDay]; // currentDay is 1-based, so this is the next entry

  const handleMarkComplete = () => {
    const isNewDay = dnsCourse.lastCompletedDate !== today;
    const nextDay = isNewDay ? Math.min(dnsCourse.currentDay + 1, DNS_COURSE.length) : dnsCourse.currentDay;
    onUpdateDnsCourse({ lastCompletedDate: today, currentDay: nextDay });
  };

  return (
    <div className="min-h-screen bg-[#080d1a] pb-20">
      <div className="bg-[#0f1829] border-b border-[#1a2a42] sticky top-0 z-30">
        <div className="p-4 flex items-center justify-between max-w-2xl mx-auto">
          <button onClick={onBack} className="text-[#6b849e] hover:text-[#f0f4f8] flex items-center gap-1 transition-colors">
            <ArrowLeft size={20} /> Back
          </button>
          <div className="font-semibold text-[#f0f4f8]">12-Week DNS Foundations</div>
          <div className="w-16" />
        </div>
      </div>

      <div className="max-w-2xl mx-auto p-6 mt-6">
        <div className="text-center mb-6">
          <div
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold mb-3"
            style={{ backgroundColor: 'rgba(0,212,200,0.1)', color: '#00d4c8', border: '1px solid rgba(0,212,200,0.3)' }}
          >
            {currentDayData.weekPhase} · Week {currentDayData.week} of 12
          </div>
          <h1 className="text-2xl font-bold text-[#f0f4f8]">
            Week {currentDayData.week}, Day {currentDayData.day}
          </h1>
          <p className="text-[#6b849e] text-sm mt-1">{currentDayData.weekTitle}</p>
        </div>

        {currentDayData.videoId ? (
          <VideoPlayer
            nodeId={`dns_course_day_${dnsCourse.currentDay}`}
            title={currentDayData.dayTitle}
            videoId={currentDayData.videoId}
            autoplayToken={null}
            onConsumeAutoplay={() => {}}
          />
        ) : (
          <div className="bg-[#0f1829] border border-[#1a2a42] rounded-xl aspect-video flex items-center justify-center mb-6">
            <p className="text-[#6b849e] text-sm font-semibold">Video coming soon</p>
          </div>
        )}

        <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42] mb-6">
          <h2 className="text-lg font-bold text-[#f0f4f8] mb-2">{currentDayData.dayTitle}</h2>
          <p className="text-[#6b849e] text-sm leading-relaxed">{currentDayData.description}</p>
        </div>

        <button
          onClick={handleMarkComplete}
          disabled={isSameDayAlreadyCompleted}
          className="w-full py-4 rounded-xl font-bold text-base text-[#080d1a] hover:opacity-90 active:scale-95 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
          style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
        >
          <CheckCircle size={18} />
          {isSameDayAlreadyCompleted ? 'Completed for Today' : 'Mark Complete & Continue'}
        </button>

        {nextDayData && (
          <div
            className="mt-4 rounded-xl p-4 flex items-center gap-3 opacity-60"
            style={{ background: '#0f1829', border: '1px solid #1a2a42' }}
          >
            <Lock size={18} className="text-[#6b849e] flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-[#6b849e] uppercase tracking-wider">
                Week {nextDayData.week}, Day {nextDayData.day}
              </p>
              <p className="text-sm font-semibold text-[#f0f4f8] truncate">{nextDayData.dayTitle}</p>
              <p className="text-xs text-[#6b849e] mt-0.5">Unlocks after you complete Day {dnsCourse.currentDay}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
