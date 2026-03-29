// src/App.tsx
import { useEffect, useRef, useState } from 'react'; // Removed 'React' default import
import {
  Activity,
  Play,
  Lock,
  CheckCircle,
  ChevronRight,
  User,
  ShieldAlert,
  ArrowLeft,
  CreditCard,
  FastForward,
  HelpCircle,
  // ArrowUp,   <-- Commented out unused icons
  // ArrowDown,
  ClipboardList,
  Library,
  TrendingUp,
  TrendingDown,
  Minus,
  LogOut,
  Trash2,
  Mail,
  FileText,
  Bell,
  X,
} from 'lucide-react';

import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, onAuthStateChanged, signOut, type Auth } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot, type Firestore } from 'firebase/firestore';

import { DECISION_TREE } from './data/decisionTree';
import type { PainLogEntry, UserData } from './state/types';
import VideoPlayer from './components/VideoPlayer';
import SessionSummary from './components/SessionSummary';

// --- Firebase Configuration ---
const firebaseConfig = {
  apiKey: 'AIzaSyBlNWkezjbXlOZ7SQCuN9FWO0ScV4zuTc8',
  authDomain: 'neuroactive.firebaseapp.com',
  projectId: 'neuroactive',
  storageBucket: 'neuroactive.firebasestorage.app',
  messagingSenderId: '1010503840940',
  appId: '1:1010503840940:web:90874fb37a70c9c7115b09',
  measurementId: 'G-4X86RF0RQT',
};

// This helps organize data in the database
const appId = 'neuroactive-prod';

let auth: Auth | null = null;
let db: Firestore | null = null;

// Initialize Firebase
try {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
} catch (error) {
  console.error('Firebase Initialization Error:', error);
}

// --- Helper Components ---

const LegalDisclaimer = ({ onAgree, onCancel }: { onAgree: () => void; onCancel: () => void }) => (
  <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm animate-fade-in">
    <div className="bg-white max-w-2xl w-full rounded-xl shadow-2xl max-h-[90vh] flex flex-col">
      <div className="p-6 border-b bg-red-50 rounded-t-xl">
        <div className="flex items-center gap-3 text-red-700 mb-2">
          <ShieldAlert size={28} />
          <h2 className="text-2xl font-bold">Medical Disclaimer & Liability Waiver</h2>
        </div>
        <p className="text-sm text-red-600 font-medium">Please read carefully before proceeding.</p>
      </div>

      <div className="p-8 overflow-y-auto text-sm text-gray-700 space-y-4 flex-1">
        <p className="font-semibold text-lg">Dr. Bruene & NeuroActive Team</p>

        <div className="p-4 bg-gray-50 rounded-lg border border-gray-100">
          <p className="mb-2">
            <strong>1. Not Medical Advice:</strong> The content provided in this application (NeuroActive) including
            text, graphics, images, and video, is for informational and educational purposes only. It is not intended
            to be a substitute for professional medical advice, diagnosis, or treatment.
          </p>

          <p className="mb-2">
            <strong>2. No Doctor-Patient Relationship:</strong> Usage of this app does not establish a doctor-patient
            relationship between you and Dr. Bruene. Dr. Bruene is licensed in Illinois, and this application is not
            intended to provide medical services outside of this jurisdiction.
          </p>

          <p className="mb-2">
            <strong>3. Assumption of Risk:</strong> You acknowledge that participation in these exercises involves a
            risk of injury. By continuing, you voluntarily assume all risks associated with these activities.
          </p>

          <p>
            <strong>4. Emergency:</strong> If you think you may have a medical emergency, call your doctor or 911
            immediately. Do not disregard professional medical advice or delay in seeking it because of something you
            have read in this app.
          </p>
        </div>

        <p className="text-xs text-gray-500 mt-4">By clicking "I Agree", you acknowledge that you have read and understood these terms.</p>
      </div>

      <div className="p-6 border-t bg-gray-50 rounded-b-xl flex justify-end gap-3">
        <button onClick={onCancel} className="px-4 py-2 text-gray-600 font-medium hover:bg-gray-200 rounded-lg transition-colors">
          Decline
        </button>
        <button
          onClick={onAgree}
          className="px-6 py-2 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 shadow-lg transition-all transform hover:scale-105"
        >
          I Agree & Understand
        </button>
      </div>
    </div>
  </div>
);

// --- Settings Component ---
const SettingsView = ({
  isPremium,
  onBack,
  onLogout,
  onReset,
  onUpgrade,
}: {
  isPremium: boolean;
  onBack: () => void;
  onLogout: () => void;
  onReset: () => void;
  onUpgrade: () => void;
}) => {
  return (
    <div className="min-h-screen bg-[#080d1a] pb-20">
      <div className="bg-[#0f1829] border-b border-[#1a2a42] sticky top-0 z-30 flex items-center justify-between p-4">
        <button onClick={onBack} className="text-[#6b849e] hover:text-[#f0f4f8] flex items-center gap-1 transition-colors">
          <ArrowLeft size={20} /> Back
        </button>
        <div className="font-semibold text-[#f0f4f8]">Profile & Settings</div>
        <div className="w-16"></div>
      </div>

      <div className="max-w-xl mx-auto p-6 space-y-6">
        {/* User card */}
        <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42] flex items-center gap-4">
          <div className="bg-[#00d4c8]/15 p-4 rounded-full border border-[#00d4c8]/30">
            <User size={32} className="text-[#00d4c8]" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-[#f0f4f8]">Guest User</h2>
            <p className="text-sm text-[#6b849e]">NeuroActive Member</p>
          </div>
        </div>

        {/* Subscription */}
        <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42]">
          <h3 className="font-bold text-[#f0f4f8] mb-4 flex items-center gap-2">
            <CreditCard size={20} className="text-[#7c5cfc]" /> Subscription
          </h3>
          <div className="flex justify-between items-center bg-[#080d1a] p-4 rounded-xl border border-[#1a2a42]">
            <div>
              <span className="text-xs font-bold text-[#6b849e] uppercase">Current Plan</span>
              <div className="text-lg font-bold text-[#f0f4f8]">{isPremium ? 'God Mode (Pro)' : 'Free Tier'}</div>
            </div>
            {isPremium ? (
              <span className="bg-[#00e096]/15 text-[#00e096] border border-[#00e096]/30 px-3 py-1 rounded-full text-xs font-bold">Active</span>
            ) : (
              <button
                onClick={onUpgrade}
                className="px-4 py-2 rounded-lg text-sm font-bold text-[#080d1a] hover:opacity-90 transition-all"
                style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
              >
                Upgrade
              </button>
            )}
          </div>
        </div>

        {/* Support */}
        <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42] space-y-1">
          <h3 className="font-bold text-[#f0f4f8] mb-3 flex items-center gap-2">
            <HelpCircle size={20} className="text-[#00d4c8]" /> Support
          </h3>
          <button className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-[#1a2a42] text-left transition-colors">
            <span className="flex items-center gap-3 text-[#6b849e]">
              <Mail size={18} /> Contact Dr. Bruene
            </span>
            <ChevronRight size={16} className="text-[#1a2a42]" />
          </button>
          <button className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-[#1a2a42] text-left transition-colors">
            <span className="flex items-center gap-3 text-[#6b849e]">
              <FileText size={18} /> Terms of Service
            </span>
            <ChevronRight size={16} className="text-[#1a2a42]" />
          </button>
        </div>

        {/* Danger zone */}
        <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#ff4466]/20">
          <h3 className="font-bold text-[#ff4466] mb-2 flex items-center gap-2">
            <ShieldAlert size={20} /> Danger Zone
          </h3>
          <p className="text-sm text-[#6b849e] mb-4">Resetting your journey will clear your current prescription and history. This cannot be undone.</p>
          <button
            onClick={() => {
              if (confirm('Are you sure you want to reset your journey? All progress will be lost.')) {
                onReset();
              }
            }}
            className="w-full bg-[#080d1a] border border-[#ff4466]/30 text-[#ff4466] py-3 rounded-lg font-bold hover:bg-[#ff4466]/10 transition-colors flex items-center justify-center gap-2"
          >
            <Trash2 size={18} /> Reset Journey
          </button>
        </div>

        <button onClick={onLogout} className="w-full text-[#6b849e] font-medium py-4 hover:text-[#f0f4f8] flex items-center justify-center gap-2 transition-colors">
          <LogOut size={18} /> Sign Out
        </button>
      </div>
    </div>
  );
};

// --- Welcome Video Screen ---
const WelcomeVideoScreen = ({
  onContinue,
}: {
  onContinue: () => void;
}) => (
  <div className="min-h-screen bg-[#080d1a] flex flex-col">
    <div className="bg-[#0f1829] border-b border-[#1a2a42] px-6 py-4 flex items-center justify-between">
      <span className="font-semibold text-[#f0f4f8]">Welcome to NeuroActive</span>
      <button
        onClick={onContinue}
        className="text-sm text-[#6b849e] hover:text-[#f0f4f8] transition-colors"
      >
        Skip
      </button>
    </div>
    <div className="flex-1 flex flex-col max-w-2xl mx-auto w-full px-6 py-8 gap-6">
      <VideoPlayer
        nodeId="onboarding_welcome"
        title="Welcome to NeuroActive"
        videoId="PLACEHOLDER_WELCOME"
        autoplayToken={null}
        onConsumeAutoplay={() => {}}
      />
      <p className="text-sm text-[#6b849e] leading-relaxed text-center">
        A quick orientation before you begin. Dr. Bruene explains what to expect, how to get the most out of the app, and what makes this approach different.
      </p>
      <button
        onClick={onContinue}
        className="w-full py-4 rounded-xl font-bold text-[#080d1a] text-base hover:opacity-90 transition-all"
        style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
      >
        Continue to Dashboard
      </button>
    </div>
  </div>
);

// --- Baseline Pain Capture Screen ---
const BaselineCaptureScreen = ({
  onSave,
  todayISO,
}: {
  onSave: (entry: PainLogEntry) => Promise<void>;
  todayISO: () => string;
}) => {
  const [score, setScore] = useState(5);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    await onSave({ date: todayISO(), score, status: 'Same' });
    // painLog.length becomes > 0 after save — parent re-render switches to Dashboard automatically
  };

  return (
    <div className="min-h-screen bg-[#080d1a] flex flex-col">
      <div className="bg-[#0f1829] border-b border-[#1a2a42] px-6 py-4 flex items-center">
        <span className="font-semibold text-[#f0f4f8]">Before we begin</span>
      </div>
      <div className="flex-1 flex flex-col max-w-md mx-auto w-full px-6 py-12 gap-8">
        <div>
          <h1 className="text-2xl font-bold text-[#f0f4f8] mb-3">Before we begin</h1>
          <p className="text-[#6b849e] leading-relaxed">
            Rate your current pain level so we have a baseline to measure your progress against. You will log this daily going forward.
          </p>
        </div>
        <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42]">
          <label className="block text-sm font-medium text-[#6b849e] mb-4">Pain Level (0–10)</label>
          <input
            type="range"
            min="0"
            max="10"
            value={score}
            onChange={(e) => setScore(parseInt(e.target.value))}
            className="w-full h-2 bg-[#1a2a42] rounded-lg appearance-none cursor-pointer accent-[#00d4c8]"
          />
          <div className="flex justify-between items-center text-xs text-[#6b849e] mt-3">
            <span>No Pain</span>
            <span className="font-bold text-[#f0f4f8] text-3xl">{score}</span>
            <span>Worst Possible</span>
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full py-4 rounded-xl font-bold text-[#080d1a] text-base disabled:opacity-50 hover:opacity-90 transition-all"
          style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
        >
          {saving ? 'Saving…' : 'Save & Continue'}
        </button>
      </div>
    </div>
  );
};

// --- Pain Tracker Component ---
const PainTracker = ({
  onSaveLog,
  existingLog,
  todayISO,
}: {
  onSaveLog: (entry: PainLogEntry) => void;
  existingLog?: PainLogEntry;
  todayISO: () => string;
}) => {
  const [score, setScore] = useState(existingLog ? existingLog.score : 5);
  const [status, setStatus] = useState<'Better' | 'Same' | 'Worse' | null>(existingLog ? existingLog.status : null);
  const [submitted, setSubmitted] = useState(!!existingLog);

  // Sync state when existingLog loads (e.g. from Firestore)
  useEffect(() => {
    if (existingLog) {
      setScore(existingLog.score);
      setStatus(existingLog.status);
      setSubmitted(true);
    }
  }, [existingLog]);

  const handleSubmit = () => {
    if (!status) return;
    const entry: PainLogEntry = {
      date: todayISO(),
      score,
      status,
    };
    onSaveLog(entry);
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#00e096]/20 text-center animate-fade-in">
        <CheckCircle className="text-[#00e096] mx-auto mb-2" size={32} />
        <h3 className="font-bold text-[#f0f4f8]">Check-in Complete</h3>
        <p className="text-sm text-[#6b849e]">Thanks for logging your progress today.</p>
        <div className="mt-4 flex justify-center gap-4 text-sm">
          <div className="bg-[#1a2a42] text-[#f0f4f8] px-3 py-1 rounded">
            Pain: <strong>{score}/10</strong>
          </div>
          <div
            className={`px-3 py-1 rounded font-bold ${
              status === 'Better' ? 'bg-[#00e096]/15 text-[#00e096]' : status === 'Worse' ? 'bg-[#ff4466]/15 text-[#ff4466]' : 'bg-[#ffcc00]/15 text-[#ffcc00]'
            }`}
          >
            {status}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42]">
      <h3 className="font-bold text-lg text-[#f0f4f8] mb-4 flex items-center gap-2">
        <Activity className="text-[#00d4c8]" /> Daily Check-in
      </h3>

      <div className="mb-6">
        <label className="block text-sm font-medium text-[#6b849e] mb-2">Pain Level (0-10)</label>
        <input
          type="range"
          min="0"
          max="10"
          value={score}
          onChange={(e) => setScore(parseInt(e.target.value))}
          className="w-full h-2 bg-[#1a2a42] rounded-lg appearance-none cursor-pointer accent-[#00d4c8]"
        />
        <div className="flex justify-between text-xs text-[#6b849e] mt-1">
          <span>No Pain</span>
          <span className="font-bold text-[#f0f4f8] text-lg">{score}</span>
          <span>Worst Possible</span>
        </div>
      </div>

      <div className="mb-6">
        <label className="block text-sm font-medium text-[#6b849e] mb-2">Status vs Yesterday</label>
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => setStatus('Better')}
            className={`p-3 rounded-lg border text-sm font-medium transition-all ${
              status === 'Better' ? 'bg-[#00e096]/20 text-[#00e096] border-[#00e096]' : 'bg-[#080d1a] border-[#1a2a42] text-[#6b849e] hover:border-[#00e096]/50'
            }`}
          >
            <TrendingUp className="mx-auto mb-1" size={16} /> Better
          </button>
          <button
            onClick={() => setStatus('Same')}
            className={`p-3 rounded-lg border text-sm font-medium transition-all ${
              status === 'Same' ? 'bg-[#ffcc00]/20 text-[#ffcc00] border-[#ffcc00]' : 'bg-[#080d1a] border-[#1a2a42] text-[#6b849e] hover:border-[#ffcc00]/50'
            }`}
          >
            <Minus className="mx-auto mb-1" size={16} /> Same
          </button>
          <button
            onClick={() => setStatus('Worse')}
            className={`p-3 rounded-lg border text-sm font-medium transition-all ${
              status === 'Worse' ? 'bg-[#ff4466]/20 text-[#ff4466] border-[#ff4466]' : 'bg-[#080d1a] border-[#1a2a42] text-[#6b849e] hover:border-[#ff4466]/50'
            }`}
          >
            <TrendingDown className="mx-auto mb-1" size={16} /> Worse
          </button>
        </div>
      </div>

      <button
        onClick={handleSubmit}
        disabled={!status}
        className="w-full py-3 rounded-lg font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition-all text-[#080d1a]"
        style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
      >
        Save Log
      </button>
    </div>
  );
};

const PainGraph = ({ logs }: { logs: PainLogEntry[] }) => {
  const last7Logs = logs.slice(-7);
  if (logs.length === 0) return null;

  let trend: { label: string; color: string; Icon: typeof TrendingDown } | null = null;
  if (logs.length >= 3) {
    const last3 = logs.slice(-3);
    const prevAvg = (last3[0].score + last3[1].score) / 2;
    const latest = last3[2].score;
    if (latest < prevAvg - 0.5) {
      trend = { label: 'Pain improving', color: '#00e096', Icon: TrendingDown };
    } else if (latest > prevAvg + 0.5) {
      trend = { label: 'Pain worsening', color: '#ff4466', Icon: TrendingUp };
    } else {
      trend = { label: 'Holding steady', color: '#ffcc00', Icon: Minus };
    }
  }

  return (
    <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42] mt-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-bold text-sm text-[#6b849e] uppercase tracking-wider">Pain History</h3>
        {trend && (
          <div className="flex items-center gap-1 text-xs font-bold" style={{ color: trend.color }}>
            <trend.Icon size={13} />
            {trend.label}
          </div>
        )}
      </div>
      <div className="flex items-end justify-between h-32 gap-2">
        {last7Logs.map((log, i) => (
          <div key={i} className="flex flex-col items-center flex-1">
            <div
              className="w-full rounded-t-sm transition-all"
              style={{
                height: `${(log.score / 10) * 100}%`,
                minHeight: '4px',
                backgroundColor: log.score < 4 ? '#00e096' : log.score < 7 ? '#ffcc00' : '#ff4466',
              }}
            />
            <span className="text-[10px] text-[#6b849e] mt-1">{log.date.slice(5)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const LibraryView = ({ isPremium, onUnlock, onPlay }: { isPremium: boolean; onUnlock: () => void; onPlay: (id: string) => void }) => {
  const [filter, setFilter] = useState<'All' | 'Supine' | 'Prone' | 'Side Lying' | 'Quadruped' | 'MDT' | 'Orientation'>('All');

  const libraryItems = Object.values(DECISION_TREE).filter((node) => node.type === 'video' && node.libraryCategory);
  const filteredItems = filter === 'All' ? libraryItems : libraryItems.filter((item) => item.libraryCategory === filter);

  return (
    <div className="min-h-screen bg-[#080d1a] pb-20">
      <div className="bg-[#0f1829] border-b border-[#1a2a42] sticky top-0 z-30 p-4">
        <h2 className="text-2xl font-bold text-[#f0f4f8] mb-4 flex items-center gap-2">
          <Library className="text-[#00d4c8]" /> Movement Library
        </h2>
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
          {['All', 'Orientation', 'Supine', 'Prone', 'Side Lying', 'Quadruped', 'MDT'].map((cat) => (
            <button
              key={cat}
              onClick={() => setFilter(cat as any)}
              className="px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all"
              style={
                filter === cat
                  ? { background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)', color: '#080d1a' }
                  : { backgroundColor: '#1a2a42', color: '#6b849e' }
              }
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4 grid md:grid-cols-2 gap-4 max-w-5xl mx-auto">
        {!isPremium && (
          <div className="col-span-full rounded-xl p-6 mb-2 border border-[#00d4c8]/20 flex justify-between items-center" style={{ background: 'linear-gradient(135deg, rgba(0,212,200,0.12), rgba(124,92,252,0.12))' }}>
            <div>
              <h3 className="font-bold text-lg text-[#f0f4f8] mb-1">Unlock God Mode</h3>
              <p className="text-[#6b849e] text-sm">Access the full DNS & MDT exercise library.</p>
            </div>
            <button
              onClick={onUnlock}
              className="px-4 py-2 rounded-lg font-bold text-sm text-[#080d1a] hover:opacity-90 transition-all flex-shrink-0 ml-4"
              style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
            >
              Upgrade
            </button>
          </div>
        )}

        {filteredItems.map((item) => (
          <div key={item.id} className="bg-[#0f1829] rounded-xl border border-[#1a2a42] overflow-hidden group hover:border-[#00d4c8]/30 transition-all">
            <div className="aspect-video relative flex items-center justify-center">
              {/* Dark thumbnail background */}
              <div className="absolute inset-0 bg-gradient-to-br from-[#0f1829] via-[#1a2a42] to-[#080d1a]" />
              <div className="absolute inset-0 opacity-25 bg-[radial-gradient(circle_at_30%_20%,#00d4c8,transparent_50%),radial-gradient(circle_at_70%_70%,#7c5cfc,transparent_50%)]" />

              {item.isPremium && !isPremium ? (
                <div className="absolute inset-0 bg-[#080d1a]/70 flex flex-col items-center justify-center backdrop-blur-sm z-10">
                  <Lock size={28} className="mb-2 text-[#6b849e]" />
                  <span className="text-xs font-bold text-[#6b849e] uppercase tracking-wider">Premium</span>
                </div>
              ) : (
                <Play size={36} className="relative z-10 text-[#6b849e] group-hover:text-[#00d4c8] transition-colors" />
              )}

              <div className="absolute bottom-3 left-3 right-3 z-10">
                <div className="text-xs font-semibold text-[#6b849e] uppercase tracking-wider">{item.libraryCategory}</div>
                <div className="text-sm font-bold text-[#f0f4f8] line-clamp-1">{item.text}</div>
              </div>
            </div>

            <div className="p-4">
              <div className="flex justify-between items-start mb-2">
                <span className="text-xs font-bold text-[#00d4c8] bg-[#00d4c8]/10 px-2 py-1 rounded">{item.libraryCategory}</span>
                {item.isPremium && (
                  <span className="text-xs text-[#7c5cfc] font-bold flex items-center gap-1">
                    <Activity size={12} /> Pro
                  </span>
                )}
              </div>
              <h3 className="font-bold text-[#f0f4f8] mb-1">{item.text}</h3>
              <p className="text-xs text-[#6b849e] line-clamp-2">{item.description}</p>
              <button
                onClick={() => {
                  if (item.isPremium && !isPremium) {
                    onUnlock();
                  } else {
                    onPlay(item.id);
                  }
                }}
                className="mt-4 w-full border border-[#00d4c8]/40 text-[#00d4c8] text-sm font-medium py-2 rounded-lg hover:bg-[#00d4c8]/10 transition-colors"
              >
                {item.isPremium && !isPremium ? 'Unlock to Watch' : 'Watch Video'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// --- Main App Component ---
export default function App() {
  const [currentView, setCurrentView] = useState<'landing' | 'assessment' | 'dashboard' | 'paywall' | 'library' | 'settings'>('landing');
  const [currentNodeId, setCurrentNodeId] = useState<string>('start');
  const [history, setHistory] = useState<string[]>([]);
  const [isPremium, setIsPremium] = useState(false);
  const [activePrescriptions, setActivePrescriptions] = useState<string[]>([]);
  const [activeJourney, setActiveJourney] = useState<string | null>(null);
  const [painLog, setPainLog] = useState<PainLogEntry[]>([]);
  const [troubleshootingAttempts, setTroubleshootingAttempts] = useState(0);
  const [checkInBannerDismissed, setCheckInBannerDismissed] = useState(false);
  const painTrackerRef = useRef<HTMLDivElement>(null);
  const [hasWatchedWelcome, setHasWatchedWelcome] = useState(false);
  const [hasWatchedAssessmentIntro, setHasWatchedAssessmentIntro] = useState(false);

  // NOTE: These are unused in this build but kept for future phases
  // const [phaseLocks, setPhaseLocks] = useState<Record<string, number>>({});
  // const [lastCheckInAt, setLastCheckInAt] = useState<string | null>(null);

  const [showTerms, setShowTerms] = useState(false);
  const [hasAgreedToTerms, setHasAgreedToTerms] = useState(false);
  
  // Pending state for terms agreement flow + Autoplay Intent
  const [pendingNodeId, setPendingNodeId] = useState<string | null>(null);
  const [pendingView, setPendingView] = useState<'landing' | 'assessment' | 'dashboard' | 'paywall' | 'library' | 'settings' | null>(null);
  
  // CHANGED: Token pattern "nodeId:timestamp" prevents stale autoplay across nodes
  const [autoplayToken, setAutoplayToken] = useState<string | null>(null);
  const [pendingAutoplay, setPendingAutoplay] = useState(false);
  
  const [simulatedTime, setSimulatedTime] = useState<number>(Date.now());

  // --- time helpers (single source of truth)
  const todayISO = () => new Date(simulatedTime).toISOString().split('T')[0];

  // NOTE: Unused, kept for future logic
  /*
  const hasTodayCheckIn = () => {
    const t = todayISO();
    return painLog.some((l) => l.date === t);
  };

  const isPhaseLocked = (key: string) => {
    const until = phaseLocks?.[key];
    if (!until) return false;
    return simulatedTime < until;
  };
  */

  // Firebase: save user data
  const saveUserData = async (updates: Partial<UserData>) => {
    if (!auth || !db || !auth.currentUser) return;
    const uid = auth.currentUser.uid;
    const docRef = doc(db, 'artifacts', appId, 'users', uid, 'userData', 'main');
    await setDoc(docRef, updates, { merge: true });
  };

  // NOTE: Unused in this build
  /*
  const lockPhaseForHours = async (key: string, hours: number) => {
    const until = simulatedTime + hours * 60 * 60 * 1000;
    const updated = { ...(phaseLocks || {}), [key]: until };
    setPhaseLocks(updated);
    await saveUserData({ phaseLocks: updated });
  };
  */

  // Firebase Auth & Data Sync
  useEffect(() => {
    if (!auth || !db) return;

    let unsubscribeSnapshot: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = null;
      }

      if (user) {
        const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'userData', 'main');

        unsubscribeSnapshot = onSnapshot(docRef, (docSnap) => {
          if (!docSnap.exists()) return;

          const data = docSnap.data() as Partial<UserData>;

          if (typeof data.activeJourney !== 'undefined') setActiveJourney(data.activeJourney ?? null);
          if (Array.isArray(data.activePrescriptions)) setActivePrescriptions(data.activePrescriptions);
          if (Array.isArray(data.history)) setHistory(data.history);
          if (typeof data.currentNodeId === 'string') setCurrentNodeId(data.currentNodeId);
          if (typeof data.isPremium === 'boolean') setIsPremium(data.isPremium);
          if (Array.isArray(data.painLog)) setPainLog(data.painLog);
          // if (data.phaseLocks && typeof data.phaseLocks === 'object') setPhaseLocks(data.phaseLocks as Record<string, number>);
          // if (typeof data.lastCheckInAt === 'string') setLastCheckInAt(data.lastCheckInAt);
          if (typeof data.hasAgreedToTerms === 'boolean') setHasAgreedToTerms(data.hasAgreedToTerms);
          setTroubleshootingAttempts(data.troubleshootingAttempts ?? 0);
          setHasWatchedWelcome(data.hasWatchedWelcome ?? false);
          setHasWatchedAssessmentIntro(data.hasWatchedAssessmentIntro ?? false);
        });
      } else {
        signInAnonymously(auth).catch(console.error);
      }
    });

    return () => {
      if (unsubscribeSnapshot) unsubscribeSnapshot();
      unsubscribeAuth();
    };
  }, []);

  const handleSavePainLog = async (entry: PainLogEntry) => {
    // Replace today's log if it already exists
    const next = [...painLog.filter((l) => l.date !== entry.date), entry].sort((a, b) => a.date.localeCompare(b.date));
    setPainLog(next);
    // setLastCheckInAt(entry.date);
    await saveUserData({ painLog: next, lastCheckInAt: entry.date });
  };

  const handleResetJourney = async () => {
    const updates: Partial<UserData> = {
      activeJourney: null,
      activePrescriptions: [],
      history: [],
      currentNodeId: 'start',
      troubleshootingAttempts: 0,
    };
    await saveUserData(updates);

    setActiveJourney(null);
    setActivePrescriptions([]);
    setHistory([]);
    setCurrentNodeId('start');
    setTroubleshootingAttempts(0);
    setCurrentView('dashboard');
    setAutoplayToken(null);
  };

  const handleLogout = async () => {
    if (!auth) return;
    await signOut(auth);

    setActiveJourney(null);
    setActivePrescriptions([]);
    setHistory([]);
    setCurrentNodeId('start');
    setIsPremium(false);
    setPainLog([]);
    // setPhaseLocks({});
    // setLastCheckInAt(null);
    setHasAgreedToTerms(false);
    setCurrentView('landing');
    setAutoplayToken(null);
  };

  // UPDATED: Honest navigation intent handler (Strict Mode)
  const attemptNavigation = (
    targetView: 'assessment' | 'dashboard' | 'library',
    nodeId?: string,
    autoplay: boolean = false
  ) => {
    if (hasAgreedToTerms) {
      if (targetView === 'assessment') {
        if (nodeId) {
          setCurrentNodeId(nodeId);
          if (autoplay) setAutoplayToken(`${nodeId}:${Date.now()}`);
          else setAutoplayToken(null);
        } else {
          // No specific node means "fresh assessment", kill any stale autoplay intent
          setAutoplayToken(null);
        }
      } else {
        // Leaving assessment implies killing the video token
        setAutoplayToken(null);
      }
      
      setCurrentView(targetView);
    } else {
      setPendingView(targetView);
      if (nodeId && targetView === 'assessment') setPendingNodeId(nodeId);
      setPendingAutoplay(autoplay); // Store intent
      setShowTerms(true);
    }
  };

  const handleTermsAgree = () => {
    setHasAgreedToTerms(true);
    setShowTerms(false);
    saveUserData({ hasAgreedToTerms: true });

    // Capture intent locally before clearing state (clean atomic transition)
    const nextNode = pendingNodeId;
    const nextView = pendingView;
    const shouldAutoplay = pendingAutoplay;

    // Clear pending state immediately
    setPendingNodeId(null);
    setPendingView(null);
    setPendingAutoplay(false);

    // Apply intent
    if (nextView === 'assessment') {
      if (nextNode) {
        setCurrentNodeId(nextNode);
        setAutoplayToken(shouldAutoplay ? `${nextNode}:${Date.now()}` : null);
      } else {
        // terms accepted then entering assessment generically: kill any stale token
        setAutoplayToken(null);
      }
    } else {
      // Going elsewhere? kill token
      setAutoplayToken(null);
    }
    
    if (nextView) {
      setCurrentView(nextView as any);
    }
  };

  const handleTermsDecline = () => {
    setShowTerms(false);
    setPendingView(null);
    setPendingNodeId(null);
    setPendingAutoplay(false);
  };

  const handleOptionClick = (nextId: string) => {
    const nextNode = DECISION_TREE[nextId];

    if (!nextNode) {
      console.error(`Decision tree missing node: ${nextId}`);
      return;
    }

    const updates: Partial<UserData> = { currentNodeId: nextId };

    // Mark assessment intro as watched when navigating away from it
    if (currentNodeId === 'onboarding_assessment_intro' && !hasWatchedAssessmentIntro) {
      setHasWatchedAssessmentIntro(true);
      updates.hasWatchedAssessmentIntro = true;
    }

    if (nextId.includes('troubleshoot')) {
      const newCount = troubleshootingAttempts + 1;
      setTroubleshootingAttempts(newCount);
      updates.troubleshootingAttempts = newCount;
    }

    if (nextNode.journeyName) {
      setActiveJourney(nextNode.journeyName);
      updates.activeJourney = nextNode.journeyName;
    }

    if (nextNode.type === 'video') {
      const toRemove = new Set(nextNode.replaces ?? []);
      const newPrescriptions = [
        ...activePrescriptions.filter((id) => id !== nextId && !toRemove.has(id)),
        nextId,
      ];
      setActivePrescriptions(newPrescriptions);
      updates.activePrescriptions = newPrescriptions;
    }

    if (nextNode.prescribes && nextNode.prescribes.length > 0) {
      const toAdd = nextNode.prescribes;
      const existing = new Set(activePrescriptions);
      const newPrescriptions = [
        ...activePrescriptions,
        ...toAdd.filter((id) => !existing.has(id)),
      ];
      setActivePrescriptions(newPrescriptions);
      updates.activePrescriptions = newPrescriptions;
    }

    const newHistory = [...history, currentNodeId];
    setHistory(newHistory);
    updates.history = newHistory;

    // Clear autoplay intent when navigating deeper
    setAutoplayToken(null);
    setCurrentNodeId(nextId);

    saveUserData(updates);
  };

  const handleUpgrade = () => {
    setIsPremium(true);
    setCurrentView('dashboard');
    saveUserData({ isPremium: true });
  };

  const LandingPage = () => (
    <div className="flex flex-col min-h-screen bg-[#080d1a]">
      <header
        className="flex justify-between items-center p-6 border-b sticky top-0 z-50 backdrop-blur-md border-[#1a2a42]"
        style={{ backgroundColor: 'rgba(8,13,26,0.85)' }}
      >
        <div className="flex items-center gap-2">
          <img
            src="/logo.png"
            alt="NeuroActive"
            className="h-10 w-auto object-contain"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).src = '/logo.png';
            }}
          />
          <span className="text-xl font-bold text-[#f0f4f8]">NeuroActive</span>
        </div>
        <button
          onClick={() => attemptNavigation('dashboard')}
          className="text-sm font-semibold text-[#00d4c8] hover:opacity-80 transition-opacity"
        >
          Login
        </button>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center text-center px-8 py-16 relative overflow-hidden">
        {/* ambient glow blobs */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full opacity-10 blur-3xl pointer-events-none" style={{ background: 'radial-gradient(circle, #00d4c8 0%, transparent 70%)' }} />
        <div className="absolute bottom-1/4 left-1/2 -translate-x-1/2 w-[400px] h-[400px] rounded-full opacity-10 blur-3xl pointer-events-none" style={{ background: 'radial-gradient(circle, #7c5cfc 0%, transparent 70%)' }} />

        <img
          src="/logo.png"
          alt="NeuroActive"
          className="h-24 w-auto object-contain mb-10 relative z-10"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).src = '/logo.png';
          }}
        />

        <h1 className="text-4xl md:text-5xl font-extrabold text-[#f0f4f8] mb-6 max-w-3xl leading-tight relative z-10">
          Choose your own adventure rehab with{' '}
          <span
            style={{
              background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}
          >
            DNS & MDT
          </span>
        </h1>

        <p className="text-lg text-[#6b849e] max-w-xl mb-10 relative z-10">
          Clinical-grade self-assessment and rehabilitation, built to guide you step by step.
        </p>

        <button
          onClick={() => attemptNavigation('dashboard')}
          className="relative z-10 px-8 py-4 rounded-full font-bold text-lg shadow-lg flex items-center gap-2 hover:opacity-90 active:scale-95 transition-all text-[#080d1a]"
          style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
        >
          Start Your Recovery <ChevronRight />
        </button>
      </main>
    </div>
  );



  const Paywall = () => (
    <div className="min-h-screen bg-[#080d1a] overflow-y-auto">
      <div className="max-w-lg mx-auto px-6 py-12 space-y-8">
        {/* Back */}
        <button onClick={() => setCurrentView('dashboard')} className="text-[#6b849e] hover:text-[#f0f4f8] flex items-center gap-1 transition-colors text-sm">
          <ArrowLeft size={16} /> Back
        </button>

        {/* Paywall hero video */}
        <VideoPlayer
          nodeId="onboarding_paywall_hero"
          title="Why NeuroActive is Different"
          videoId="PLACEHOLDER_PAYWALL_HERO"
          autoplayToken={null}
          onConsumeAutoplay={() => {}}
        />

        {/* Doctor header */}
        <div className="text-center">
          <div
            className="w-20 h-20 rounded-full mx-auto mb-5 flex items-center justify-center border-2 border-[#00d4c8]/40"
            style={{ background: 'linear-gradient(135deg, rgba(0,212,200,0.15), rgba(124,92,252,0.15))' }}
          >
            <User size={36} className="text-[#00d4c8]" />
          </div>
          <h1 className="text-2xl font-extrabold text-[#f0f4f8] mb-2">Dr. Adam Bruene, D.C., Cert. MDT, DNSP</h1>
          <p className="text-[#6b849e] text-sm leading-relaxed max-w-sm mx-auto">
            The only app built on dual certification in McKenzie MDT and Dynamic Neuromuscular Stabilization
          </p>
        </div>

        {/* Credential pills */}
        <div className="flex flex-wrap justify-center gap-2">
          {[
            'Licensed Chiropractic Physician · Illinois',
            'Certified McKenzie Practitioner (MDT)',
            'DNS Certified Practitioner (DNSP)',
          ].map((cred) => (
            <span
              key={cred}
              className="text-xs font-semibold px-3 py-1.5 rounded-full text-[#00d4c8]"
              style={{ border: '1px solid rgba(0,212,200,0.4)', backgroundColor: 'rgba(0,212,200,0.08)' }}
            >
              {cred}
            </span>
          ))}
        </div>

        {/* Bio */}
        <div className="bg-[#0f1829] border border-[#1a2a42] rounded-2xl p-6">
          <p className="text-[#6b849e] text-sm leading-relaxed">
            "15+ years of clinical experience in spine rehabilitation and movement-based care. Treated patients across MLB, NHL, MLS, and international rugby. This app runs on the same clinical reasoning frameworks used in real practice — not generic exercise content."
          </p>
        </div>

        {/* Feature list */}
        <div className="bg-[#0f1829] border border-[#1a2a42] rounded-2xl p-6 space-y-3">
          <h3 className="font-bold text-[#f0f4f8] mb-4">What you unlock</h3>
          {[
            'Full DNS Developmental Exercise Library',
            'All MDT Assessment Protocols',
            'Cervical & Lumbar clinical pathways',
            'Premium video instruction for every drill',
            'New clinical content added regularly',
          ].map((feature) => (
            <div key={feature} className="flex items-start gap-3">
              <CheckCircle size={16} className="text-[#00d4c8] flex-shrink-0 mt-0.5" />
              <span className="text-sm text-[#f0f4f8]">{feature}</span>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="space-y-3 pb-8">
          <button
            onClick={handleUpgrade}
            className="w-full py-4 rounded-xl font-bold text-lg text-[#080d1a] hover:opacity-90 active:scale-95 transition-all flex justify-center items-center gap-2"
            style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
          >
            <CreditCard size={20} /> Start 7-Day Free Trial
          </button>
          <button onClick={() => setCurrentView('dashboard')} className="w-full text-[#6b849e] text-sm hover:text-[#f0f4f8] transition-colors py-2">
            No thanks, take me back
          </button>
        </div>
      </div>
    </div>
  );

  const Dashboard = () => {
    const today = todayISO();
    const todayLog = painLog.find((log) => log.date === today);

    const streak = (() => {
      if (painLog.length === 0) return 0;
      const logDates = new Set(painLog.map((l) => l.date));
      const cursor = new Date(simulatedTime);
      if (!logDates.has(cursor.toISOString().split('T')[0])) {
        cursor.setDate(cursor.getDate() - 1);
      }
      let count = 0;
      while (logDates.has(cursor.toISOString().split('T')[0])) {
        count++;
        cursor.setDate(cursor.getDate() - 1);
      }
      return count;
    })();

    const flagAccent: Record<string, string> = {
      green: '#00e096',
      yellow: '#ffcc00',
      red: '#ff4466',
    };

    return (
      <div className="min-h-screen bg-[#080d1a] pb-20">
        <div className="border-b sticky top-0 z-30 bg-[#0f1829] border-[#1a2a42]">
          <div className="max-w-5xl mx-auto px-6 py-4 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <img src="/logo.png" alt="NeuroActive" className="h-8 w-auto object-contain" onError={(e) => ((e.currentTarget as HTMLImageElement).src = '/logo.png')} />
              <span className="font-bold text-[#f0f4f8]">NeuroActive</span>
            </div>
            <div className="flex items-center gap-4">
              {!isPremium && (
                <button
                  onClick={() => setCurrentView('paywall')}
                  className="text-xs font-bold text-[#080d1a] px-3 py-1.5 rounded-full hover:opacity-90 transition-all"
                  style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
                >
                  UPGRADE
                </button>
              )}
              <button onClick={() => setCurrentView('settings')} className="bg-[#1a2a42] p-2 rounded-full hover:opacity-80 transition-opacity">
                <User size={20} className="text-[#6b849e]" />
              </button>
            </div>
          </div>
        </div>

        <div className="max-w-5xl mx-auto p-6 space-y-8">
          {(() => {
            const hasStartedAssessment = activeJourney !== null || history.length > 0;
            return (
              <>
                {hasStartedAssessment && !todayLog && !checkInBannerDismissed && (
                  <div
                    className="flex items-center gap-3 px-4 py-3 rounded-xl"
                    style={{ background: 'rgba(0,212,200,0.08)', border: '1px solid rgba(0,212,200,0.25)' }}
                  >
                    <Bell size={18} className="flex-shrink-0" style={{ color: '#00d4c8' }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-[#f0f4f8]">You haven't logged your pain today</p>
                      <p className="text-xs text-[#6b849e]">Daily tracking helps us spot your progress</p>
                    </div>
                    <button
                      onClick={() => painTrackerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                      className="flex-shrink-0 text-xs font-bold px-3 py-1.5 rounded-lg transition-colors hover:opacity-80"
                      style={{ background: 'rgba(0,212,200,0.15)', color: '#00d4c8', border: '1px solid rgba(0,212,200,0.3)' }}
                    >
                      Log Now
                    </button>
                    <button
                      onClick={() => setCheckInBannerDismissed(true)}
                      className="flex-shrink-0 text-[#6b849e] hover:text-[#f0f4f8] transition-colors"
                      aria-label="Dismiss"
                    >
                      <X size={16} />
                    </button>
                  </div>
                )}

                <div className="bg-[#0f1829] p-8 rounded-2xl border border-[#1a2a42] flex flex-col md:flex-row items-center justify-between gap-6">
                  <div>
                    <h1 className="text-2xl font-bold text-[#f0f4f8] mb-2">Welcome back.</h1>
                    <p className="text-[#6b849e]">
                      You are currently on the <span className="font-bold text-[#00d4c8]">{activeJourney || 'General'}</span> track.
                    </p>
                    {streak > 0 && (
                      <div className="flex items-center gap-1.5 mt-3 text-sm font-bold" style={{ color: '#ffcc00' }}>
                        <Activity size={14} />
                        {streak}-day check-in streak
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => {
                      setHistory([]);
                      setCurrentNodeId(!hasWatchedAssessmentIntro ? 'onboarding_assessment_intro' : 'start');
                      attemptNavigation('assessment');
                    }}
                    className="px-6 py-3 rounded-lg font-semibold text-[#080d1a] hover:opacity-90 active:scale-95 transition-all"
                    style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
                  >
                    {hasStartedAssessment ? 'New Assessment' : 'Start Assessment'}
                  </button>
                </div>

                {hasStartedAssessment ? (
                  <div ref={painTrackerRef} className="grid md:grid-cols-2 gap-6">
                    <PainTracker onSaveLog={handleSavePainLog} existingLog={todayLog} todayISO={todayISO} />
                    <PainGraph logs={painLog} />
                  </div>
                ) : (
                  <div
                    className="rounded-2xl p-8 text-center"
                    style={{ background: 'rgba(0,212,200,0.05)', border: '1px solid rgba(0,212,200,0.2)' }}
                  >
                    <div
                      className="inline-flex items-center justify-center w-14 h-14 rounded-full mb-4"
                      style={{ background: 'rgba(0,212,200,0.1)', border: '1px solid rgba(0,212,200,0.3)' }}
                    >
                      <ClipboardList size={24} style={{ color: '#00d4c8' }} />
                    </div>
                    <h3 className="text-lg font-bold text-[#f0f4f8] mb-2">Start your assessment to unlock your personalized plan</h3>
                    <p className="text-sm text-[#6b849e] mb-6">Answer a few questions about your symptoms. We'll build your rehab protocol based on your individual presentation.</p>
                    <button
                      onClick={() => {
                        setHistory([]);
                        setCurrentNodeId(!hasWatchedAssessmentIntro ? 'onboarding_assessment_intro' : 'start');
                        attemptNavigation('assessment');
                      }}
                      className="px-6 py-3 rounded-lg font-semibold text-[#080d1a] hover:opacity-90 active:scale-95 transition-all"
                      style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
                    >
                      Begin Assessment
                    </button>
                  </div>
                )}
              </>
            );
          })()}

          <div className="bg-[#0f1829] rounded-2xl border border-[#1a2a42] p-6 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="bg-[#1a2a42] p-3 rounded-full">
                <Library size={24} className="text-[#00d4c8]" />
              </div>
              <div>
                <h3 className="font-bold text-lg text-[#f0f4f8]">Movement Library</h3>
                <p className="text-[#6b849e] text-sm">Browse DNS & MDT exercises by position.</p>
              </div>
            </div>
            <button
              onClick={() => setCurrentView('library')}
              className="border border-[#00d4c8] text-[#00d4c8] px-4 py-2 rounded-lg font-bold text-sm hover:bg-[#00d4c8]/10 transition-colors"
            >
              Browse
            </button>
          </div>

          {activePrescriptions.length > 0 && (
            <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42]">
              <div className="flex items-center gap-2 mb-4">
                <ClipboardList className="text-[#7c5cfc]" />
                <h3 className="font-bold text-lg text-[#f0f4f8]">My Prescription</h3>
              </div>

              <div className="space-y-3">
                {activePrescriptions.map((id) => {
                  const node = DECISION_TREE[id];
                  if (!node) return null;
                  const accentColor = node.flagLevel ? flagAccent[node.flagLevel] : undefined;
                  return (
                    <button
                      key={id}
                      onClick={() => attemptNavigation('assessment', id, true)}
                      className="w-full bg-[#080d1a] p-4 rounded-lg border border-[#1a2a42] flex justify-between items-center hover:border-[#7c5cfc]/50 hover:bg-[#7c5cfc]/5 transition-all text-left"
                      style={accentColor ? { borderLeftColor: accentColor, borderLeftWidth: '3px' } : undefined}
                    >
                      <div>
                        <h4 className="font-bold text-[#f0f4f8]">{node.text}</h4>
                        {node.prescriptionFrequency && (
                          <div className="text-xs text-[#7c5cfc] font-bold bg-[#7c5cfc]/10 inline-block px-2 py-1 rounded mt-1">{node.prescriptionFrequency}</div>
                        )}
                      </div>
                      <Play size={20} className="text-[#6b849e]" />
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const AssessmentView = () => {
    const currentNode = DECISION_TREE[currentNodeId];

    if (!currentNode) {
      return (
        <div className="min-h-screen bg-[#080d1a] p-6">
          <div className="max-w-2xl mx-auto bg-[#0f1829] p-6 rounded-xl border border-[#1a2a42]">
            <h2 className="text-xl font-bold text-[#ff4466]">Missing Node</h2>
            <p className="text-[#6b849e] mt-2">
              The decision tree does not contain a node with id: <span className="font-mono text-[#f0f4f8]">{currentNodeId}</span>
            </p>
            <button
              onClick={() => { setCurrentNodeId('start'); setHistory([]); }}
              className="mt-4 px-4 py-2 rounded-lg font-semibold text-[#080d1a]"
              style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
            >
              Go to start
            </button>
          </div>
        </div>
      );
    }


    // Show session summary when user reaches a terminal result node that has active prescriptions.
    // Exclude waypoint result nodes (e.g. explainers) whose options lead onward to video nodes.
    const nodeLeadsToVideo = currentNode.options?.some(
      (opt) => DECISION_TREE[opt.nextId]?.type === 'video'
    );
    if (currentNode.type === 'result' && activePrescriptions.length > 0 && !nodeLeadsToVideo) {
      return (
        <SessionSummary
          nodeId={currentNodeId}
          prescriptions={activePrescriptions}
          painDrawingData={null}
          onDone={() => setCurrentView('dashboard')}
          decisionTree={DECISION_TREE}
        />
      );
    }

    const flagMap = {
      green:  { color: '#00e096', label: currentNode.flagText || 'Safe to self-manage' },
      yellow: { color: '#ffcc00', label: currentNode.flagText || 'Caution — proceed carefully' },
      red:    { color: '#ff4466', label: currentNode.flagText || 'Stop — refer out' },
    };
    const flag = currentNode.flagLevel ? flagMap[currentNode.flagLevel] : null;

    const depth = history.length;
    const progressPct = Math.min((depth / 12) * 100, 100);

    return (
      <div className="min-h-screen bg-[#080d1a] pb-20">
        {/* Header */}
        <div className="bg-[#0f1829] border-b border-[#1a2a42] sticky top-0 z-30">
          <div className="p-4 flex items-center justify-between">
            <button
              onClick={() => {
                setAutoplayToken(null);
                if (history.length > 0) {
                  const prevId = history[history.length - 1];
                  setCurrentNodeId(prevId);
                  setHistory((prev) => prev.slice(0, -1));
                } else {
                  setCurrentView('dashboard');
                }
              }}
              className="text-[#6b849e] hover:text-[#f0f4f8] flex items-center gap-1 transition-colors"
            >
              <ArrowLeft size={20} /> Back
            </button>
            <div className="font-semibold text-[#f0f4f8]">Assessment</div>
            <button
              onClick={() => setCurrentView('dashboard')}
              className="text-sm font-medium text-[#6b849e] hover:text-[#f0f4f8] transition-colors w-16 text-right"
            >
              Dashboard
            </button>
          </div>
          {/* Progress bar */}
          <div className="h-0.5 bg-[#1a2a42]">
            <div
              className="h-full transition-all duration-500 ease-out"
              style={{ width: `${progressPct}%`, background: 'linear-gradient(90deg, #00d4c8, #7c5cfc)' }}
            />
          </div>
        </div>

        <div className="max-w-2xl mx-auto p-6 mt-6">
          {/* Node card */}
          <div className="bg-[#0f1829] p-8 rounded-2xl border border-[#1a2a42] text-center mb-6">
            {flag && (
              <div
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold mb-5"
                style={{
                  backgroundColor: `${flag.color}18`,
                  color: flag.color,
                  border: `1px solid ${flag.color}40`,
                }}
              >
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: flag.color }} />
                {flag.label}
              </div>
            )}
            <h2 className="text-2xl font-bold text-[#f0f4f8] mb-4">{currentNode.text}</h2>
            <p className="text-[#6b849e]">{currentNode.description}</p>
          </div>

          {/* Phase prescription display — lb_mdt_prescription */}
          {currentNodeId === 'lb_mdt_prescription' && (
            <div className="space-y-3 mb-6">
              {[
                { title: 'Standing Extension (EIS)', detail: '10 repetitions every waking hour', nodeId: 'vid_mdt_standing_ext' },
                { title: 'Prone Press-Up (EIL)',     detail: '10 repetitions every waking hour', nodeId: 'vid_mdt_pressup' },
              ].map((rx) => (
                <button
                  key={rx.title}
                  onClick={() => {
                    console.log('[lb_mdt_prescription] navigating to:', rx.nodeId);
                    const newHistory = [...history, currentNodeId];
                    setHistory(newHistory);
                    saveUserData({ history: newHistory, currentNodeId: rx.nodeId });
                    attemptNavigation('assessment', rx.nodeId, true);
                  }}
                  className="w-full flex items-center gap-4 p-4 rounded-xl transition-all group"
                  style={{ background: '#0f1829', border: '1px solid rgba(0,212,200,0.3)', cursor: 'pointer' }}
                  onMouseEnter={(e) => (e.currentTarget.style.boxShadow = '0 0 0 1px rgba(0,212,200,0.5), 0 0 12px rgba(0,212,200,0.12)')}
                  onMouseLeave={(e) => (e.currentTarget.style.boxShadow = 'none')}
                >
                  <div
                    className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center"
                    style={{ background: 'rgba(0,212,200,0.12)' }}
                  >
                    <CheckCircle size={16} style={{ color: '#00d4c8' }} />
                  </div>
                  <div className="flex-1 text-left">
                    <p className="font-semibold text-[#f0f4f8] text-sm">{rx.title}</p>
                    <p className="text-xs text-[#00d4c8] font-medium mt-0.5">{rx.detail}</p>
                  </div>
                  <span className="flex-shrink-0 text-xs font-bold text-[#00d4c8] flex items-center gap-1 opacity-70 group-hover:opacity-100 transition-opacity">
                    <Play size={10} fill="#00d4c8" /> Watch
                  </span>
                </button>
              ))}
              <p className="text-xs text-[#6b849e] leading-relaxed px-1 pt-1">
                Use whichever is available at any given hour — think of it like having both a flathead and Phillips screwdriver. You always want the right tool for the job. The goal is extension, every hour, consistently.
              </p>
              <p className="text-xs text-[#6b849e] leading-relaxed px-1">
                Both exercises are now saved to your dashboard. Return to them anytime.
              </p>
            </div>
          )}

          {/* Video player */}
          {currentNode.type === 'video' && currentNode.videoId && (
            <VideoPlayer
              key={currentNodeId}
              nodeId={currentNodeId}
              title={currentNode.text}
              frequency={currentNode.prescriptionFrequency}
              videoId={currentNode.videoId}
              autoplayToken={autoplayToken}
              onConsumeAutoplay={() => setAutoplayToken(null)}
            />
          )}

          {/* Question options */}
          {currentNode.type !== 'video' && (() => {
            const isInTroubleshootContext = currentNodeId.includes('troubleshoot') || currentNodeId.includes('peripheralizing');
            const forceReferOut = troubleshootingAttempts >= 3 && isInTroubleshootContext;
            const effectiveOptions = forceReferOut
              ? (currentNode.options ?? []).map((opt) =>
                  opt.nextId === 'refer_out' || opt.nextId === 'refer_out_urgent'
                    ? opt
                    : { ...opt, nextId: 'refer_out' }
                )
              : (currentNode.options ?? []);
            return (
              <div className="grid gap-3">
                {forceReferOut && (
                  <div className="rounded-xl p-4 bg-yellow-900/20 border border-yellow-500/40 text-yellow-300 text-sm">
                    You have worked through several troubleshooting approaches without sufficient improvement. In-person evaluation is now recommended.
                  </div>
                )}
                {effectiveOptions.map((opt, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleOptionClick(opt.nextId)}
                    className="bg-[#0f1829] hover:bg-[#00d4c8]/5 border border-[#1a2a42] hover:border-[#00d4c8]/40 p-5 rounded-xl transition-all text-left group flex items-center justify-between"
                  >
                    <span className="text-base font-medium text-[#f0f4f8] group-hover:text-[#00d4c8] transition-colors">{opt.label}</span>
                    <ChevronRight className="text-[#1a2a42] group-hover:text-[#00d4c8] flex-shrink-0 transition-colors" />
                  </button>
                ))}
              </div>
            );
          })()}

          {/* Clinical check-in for video nodes */}
          {currentNode.type === 'video' && (() => {
            const isInTroubleshootContext = currentNodeId.includes('troubleshoot') || currentNodeId.includes('peripheralizing');
            const forceReferOut = troubleshootingAttempts >= 3 && isInTroubleshootContext;
            const effectiveOptions = forceReferOut
              ? (currentNode.options ?? []).map((opt) =>
                  opt.nextId === 'refer_out' || opt.nextId === 'refer_out_urgent'
                    ? opt
                    : { ...opt, nextId: 'refer_out' }
                )
              : (currentNode.options ?? []);
            return (
              <div className="rounded-xl p-6 mt-4 bg-[#0f1829] border border-[#1a2a42]">
                <h3 className="font-bold text-[#f0f4f8] mb-4">Clinical Check-In</h3>
                {forceReferOut && (
                  <div className="rounded-xl p-4 mb-4 bg-yellow-900/20 border border-yellow-500/40 text-yellow-300 text-sm">
                    You have worked through several troubleshooting approaches without sufficient improvement. In-person evaluation is now recommended.
                  </div>
                )}
                <div className="grid gap-3">
                  {effectiveOptions.map((opt, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleOptionClick(opt.nextId)}
                      className="bg-[#080d1a] p-4 rounded-lg border border-[#1a2a42] hover:border-[#7c5cfc]/50 hover:bg-[#7c5cfc]/5 text-left transition-all flex justify-between items-center group"
                    >
                      <span className="font-medium text-[#6b849e] group-hover:text-[#f0f4f8] transition-colors">{opt.label}</span>
                      <ChevronRight className="text-[#1a2a42] group-hover:text-[#7c5cfc] flex-shrink-0 transition-colors" size={20} />
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    );
  };

  const DevTimeSkip = () => (
    <div className="fixed bottom-4 left-4 z-50">
      <button
        onClick={() => setSimulatedTime((prev) => prev + 48 * 60 * 60 * 1000)}
        className="bg-black text-white px-4 py-2 rounded-full shadow-lg text-xs font-mono flex items-center gap-2 hover:bg-gray-800"
      >
        <FastForward size={14} /> Dev: Fast-Fwd 48h
      </button>
    </div>
  );

  return (
    <>
      {showTerms && <LegalDisclaimer onAgree={handleTermsAgree} onCancel={handleTermsDecline} />}
      {currentView === 'landing' && <LandingPage />}
      {currentView === 'paywall' && <Paywall />}
      {currentView === 'assessment' && <AssessmentView />}
      {currentView === 'dashboard' && hasAgreedToTerms && painLog.length === 0
        ? <BaselineCaptureScreen onSave={handleSavePainLog} todayISO={todayISO} />
        : currentView === 'dashboard' && !hasWatchedWelcome
        ? <WelcomeVideoScreen onContinue={() => { setHasWatchedWelcome(true); saveUserData({ hasWatchedWelcome: true }); }} />
        : currentView === 'dashboard' && <Dashboard />}
      {currentView === 'settings' && (
        <SettingsView
          isPremium={isPremium}
          onBack={() => setCurrentView('dashboard')}
          onLogout={handleLogout}
          onReset={handleResetJourney}
          onUpgrade={handleUpgrade}
        />
      )}
      {currentView === 'library' && (
        <LibraryView
          isPremium={isPremium}
          onUnlock={() => setCurrentView('paywall')}
          onPlay={(id) => {
            const newHistory = [...history, currentNodeId];
            setHistory(newHistory);
            saveUserData({ history: newHistory, currentNodeId: id });
            attemptNavigation('assessment', id, true);
          }}
        />
      )}
      {import.meta.env.DEV && <DevTimeSkip />}
    </>
  );
}