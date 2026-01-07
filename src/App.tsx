// src/App.tsx
import React, { useEffect, useState } from 'react';
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
  ArrowUp,
  ArrowDown,
  ClipboardList,
  Library,
  ExternalLink,
  TrendingUp,
  TrendingDown,
  Minus,
  LogOut,
  Trash2,
  Mail,
  FileText,
} from 'lucide-react';

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  signOut,
  type Auth,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  onSnapshot,
  type Firestore,
} from 'firebase/firestore';

import { DECISION_TREE } from './data/decisionTree';
import type { PainLogEntry, UserData } from './state/types';

// --- Firebase Configuration ---
const firebaseConfig = {
  apiKey: "AIzaSyBlNWkezjbXlOZ7SQCuN9FWO0ScV4zuTc8",
  authDomain: "neuroactive.firebaseapp.com",
  projectId: "neuroactive",
  storageBucket: "neuroactive.firebasestorage.app",
  messagingSenderId: "1010503840940",
  appId: "1:1010503840940:web:90874fb37a70c9c7115b09",
  measurementId: "G-4X86RF0RQT"
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
  console.error("Firebase Initialization Error:", error);
}

// --- Helper Components ---

const CentralizationGraphic = () => (
  <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-lg my-4 animate-fade-in">
    <div className="flex flex-col md:flex-row gap-8 justify-center items-center">
      {/* Good Side */}
      <div className="text-center">
        <h4 className="font-bold text-green-700 mb-2">Centralization (Good)</h4>
        <div className="relative w-32 h-48 bg-gray-100 rounded-lg mx-auto border-2 border-green-100">
          <div className="absolute top-2 left-1/2 -translate-x-1/2 w-8 h-8 rounded-full border-2 border-gray-300"></div>
          <div className="absolute top-10 left-1/2 -translate-x-1/2 w-0.5 h-16 bg-gray-300"></div>
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-16 h-20 border-t-2 border-gray-300"></div>
          <div className="absolute bottom-0 left-4 w-0.5 h-20 bg-gray-300"></div>
          <div className="absolute bottom-0 right-4 w-0.5 h-20 bg-gray-300"></div>
          <div className="absolute bottom-4 right-2 text-green-500 animate-bounce">
            <ArrowUp size={24} strokeWidth={3} />
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-2 max-w-[150px]">
          Pain retreats from leg/buttock towards the spine.
        </p>
      </div>

      {/* Bad Side */}
      <div className="text-center">
        <h4 className="font-bold text-red-700 mb-2">Peripheralization (Bad)</h4>
        <div className="relative w-32 h-48 bg-gray-100 rounded-lg mx-auto border-2 border-red-100">
          <div className="absolute top-2 left-1/2 -translate-x-1/2 w-8 h-8 rounded-full border-2 border-gray-300"></div>
          <div className="absolute top-10 left-1/2 -translate-x-1/2 w-0.5 h-16 bg-gray-300"></div>
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-16 h-20 border-t-2 border-gray-300"></div>
          <div className="absolute bottom-0 left-4 w-0.5 h-20 bg-gray-300"></div>
          <div className="absolute bottom-0 right-4 w-0.5 h-20 bg-gray-300"></div>
          <div className="absolute bottom-8 right-2 text-red-500">
            <ArrowDown size={24} strokeWidth={3} />
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-2 max-w-[150px]">
          Pain travels further down the leg or arm.
        </p>
      </div>
    </div>
  </div>
);

const LegalDisclaimer = ({
  onAgree,
  onCancel,
}: {
  onAgree: () => void;
  onCancel: () => void;
}) => (
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
            <strong>1. Not Medical Advice:</strong> The content provided in this application (NeuroActive)
            including text, graphics, images, and video, is for informational and educational purposes only.
            It is not intended to be a substitute for professional medical advice, diagnosis, or treatment.
          </p>

          <p className="mb-2">
            <strong>2. No Doctor-Patient Relationship:</strong> Usage of this app does not establish a
            doctor-patient relationship between you and Dr. Bruene. Dr. Bruene is licensed in Illinois,
            and this application is not intended to provide medical services outside of this jurisdiction.
          </p>

          <p className="mb-2">
            <strong>3. Assumption of Risk:</strong> You acknowledge that participation in these exercises
            involves a risk of injury. By continuing, you voluntarily assume all risks associated with
            these activities.
          </p>

          <p>
            <strong>4. Emergency:</strong> If you think you may have a medical emergency, call your doctor
            or 911 immediately. Do not disregard professional medical advice or delay in seeking it
            because of something you have read in this app.
          </p>
        </div>

        <p className="text-xs text-gray-500 mt-4">
          By clicking "I Agree", you acknowledge that you have read and understood these terms.
        </p>
      </div>

      <div className="p-6 border-t bg-gray-50 rounded-b-xl flex justify-end gap-3">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-gray-600 font-medium hover:bg-gray-200 rounded-lg transition-colors"
        >
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
    <div className="min-h-screen bg-gray-50 pb-20">
      <div className="bg-white border-b sticky top-0 z-30 flex items-center justify-between p-4">
        <button onClick={onBack} className="text-gray-500 hover:text-gray-900 flex items-center gap-1">
          <ArrowLeft size={20} /> Back
        </button>
        <div className="font-semibold text-gray-700">Profile & Settings</div>
        <div className="w-16"></div>
      </div>

      <div className="max-w-xl mx-auto p-6 space-y-6">
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex items-center gap-4">
          <div className="bg-blue-100 p-4 rounded-full">
            <User size={32} className="text-blue-600" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-gray-900">Guest User</h2>
            <p className="text-sm text-gray-500">NeuroActive Member</p>
          </div>
        </div>

        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
          <h3 className="font-bold text-gray-900 mb-4 flex items-center gap-2">
            <CreditCard size={20} className="text-purple-600" /> Subscription
          </h3>
          <div className="flex justify-between items-center bg-gray-50 p-4 rounded-xl border border-gray-200">
            <div>
              <span className="text-xs font-bold text-gray-500 uppercase">Current Plan</span>
              <div className="text-lg font-bold text-gray-900">{isPremium ? 'God Mode (Pro)' : 'Free Tier'}</div>
            </div>
            {isPremium ? (
              <span className="bg-green-100 text-green-700 px-3 py-1 rounded-full text-xs font-bold">Active</span>
            ) : (
              <button
                onClick={onUpgrade}
                className="bg-purple-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-purple-700"
              >
                Upgrade
              </button>
            )}
          </div>
        </div>

        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 space-y-4">
          <h3 className="font-bold text-gray-900 flex items-center gap-2">
            <HelpCircle size={20} className="text-blue-600" /> Support
          </h3>
          <button className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 text-left">
            <span className="flex items-center gap-3 text-gray-700">
              <Mail size={18} /> Contact Dr. Bruene
            </span>
            <ChevronRight size={16} className="text-gray-400" />
          </button>
          <button className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-gray-50 text-left">
            <span className="flex items-center gap-3 text-gray-700">
              <FileText size={18} /> Terms of Service
            </span>
            <ChevronRight size={16} className="text-gray-400" />
          </button>
        </div>

        <div className="bg-red-50 p-6 rounded-2xl border border-red-100">
          <h3 className="font-bold text-red-900 mb-2 flex items-center gap-2">
            <ShieldAlert size={20} /> Danger Zone
          </h3>
          <p className="text-sm text-red-700 mb-4">
            Resetting your journey will clear your current prescription and history. This cannot be undone.
          </p>
          <button
            onClick={() => {
              if (confirm("Are you sure you want to reset your journey? All progress will be lost.")) {
                onReset();
              }
            }}
            className="w-full bg-white border border-red-200 text-red-600 py-3 rounded-lg font-bold hover:bg-red-50 transition-colors flex items-center justify-center gap-2"
          >
            <Trash2 size={18} /> Reset Journey
          </button>
        </div>

        <button
          onClick={onLogout}
          className="w-full text-gray-400 font-medium py-4 hover:text-gray-600 flex items-center justify-center gap-2"
        >
          <LogOut size={18} /> Sign Out
        </button>
      </div>
    </div>
  );
};

// --- Pain Tracker Component ---
const PainTracker = ({
  onSaveLog,
  existingLog,
}: {
  onSaveLog: (entry: PainLogEntry) => void;
  existingLog?: PainLogEntry;
}) => {
  const [score, setScore] = useState(existingLog ? existingLog.score : 5);
  const [status, setStatus] = useState<'Better' | 'Same' | 'Worse' | null>(existingLog ? existingLog.status : null);
  const [submitted, setSubmitted] = useState(!!existingLog);

  const handleSubmit = () => {
    if (!status) return;
    const entry: PainLogEntry = {
      date: new Date().toISOString().split('T')[0],
      score,
      status,
    };
    onSaveLog(entry);
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-green-100 text-center animate-fade-in">
        <CheckCircle className="text-green-500 mx-auto mb-2" size={32} />
        <h3 className="font-bold text-gray-900">Check-in Complete</h3>
        <p className="text-sm text-gray-500">Thanks for logging your progress today.</p>
        <div className="mt-4 flex justify-center gap-4 text-sm">
          <div className="bg-gray-50 px-3 py-1 rounded">
            Pain: <strong>{score}/10</strong>
          </div>
          <div
            className={`px-3 py-1 rounded font-bold ${
              status === 'Better'
                ? 'bg-green-100 text-green-700'
                : status === 'Worse'
                ? 'bg-red-100 text-red-700'
                : 'bg-yellow-100 text-yellow-700'
            }`}
          >
            {status}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
      <h3 className="font-bold text-lg text-gray-900 mb-4 flex items-center gap-2">
        <Activity className="text-blue-600" /> Daily Check-in
      </h3>

      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">Pain Level (0-10)</label>
        <input
          type="range"
          min="0"
          max="10"
          value={score}
          onChange={(e) => setScore(parseInt(e.target.value))}
          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer"
        />
        <div className="flex justify-between text-xs text-gray-400 mt-1">
          <span>No Pain</span>
          <span className="font-bold text-gray-900 text-lg">{score}</span>
          <span>Worst Possible</span>
        </div>
      </div>

      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">Status vs Yesterday</label>
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => setStatus('Better')}
            className={`p-3 rounded-lg border text-sm font-medium transition-all ${
              status === 'Better'
                ? 'bg-green-600 text-white border-green-600'
                : 'bg-white border-gray-200 text-gray-600 hover:border-green-500'
            }`}
          >
            <TrendingUp className="mx-auto mb-1" size={16} /> Better
          </button>
          <button
            onClick={() => setStatus('Same')}
            className={`p-3 rounded-lg border text-sm font-medium transition-all ${
              status === 'Same'
                ? 'bg-yellow-500 text-white border-yellow-500'
                : 'bg-white border-gray-200 text-gray-600 hover:border-yellow-400'
            }`}
          >
            <Minus className="mx-auto mb-1" size={16} /> Same
          </button>
          <button
            onClick={() => setStatus('Worse')}
            className={`p-3 rounded-lg border text-sm font-medium transition-all ${
              status === 'Worse'
                ? 'bg-red-600 text-white border-red-600'
                : 'bg-white border-gray-200 text-gray-600 hover:border-red-500'
            }`}
          >
            <TrendingDown className="mx-auto mb-1" size={16} /> Worse
          </button>
        </div>
      </div>

      <button
        onClick={handleSubmit}
        disabled={!status}
        className="w-full bg-blue-600 text-white py-3 rounded-lg font-bold disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-700 transition-colors"
      >
        Save Log
      </button>
    </div>
  );
};

const PainGraph = ({ logs }: { logs: PainLogEntry[] }) => {
  const last7Logs = logs.slice(-7);
  if (logs.length === 0) return null;

  return (
    <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 mt-6">
      <h3 className="font-bold text-sm text-gray-500 uppercase tracking-wider mb-4">Pain History</h3>
      <div className="flex items-end justify-between h-32 gap-2">
        {last7Logs.map((log, i) => (
          <div key={i} className="flex flex-col items-center flex-1">
            <div
              className={`w-full rounded-t-sm transition-all ${
                log.score < 4 ? 'bg-green-400' : log.score < 7 ? 'bg-yellow-400' : 'bg-red-400'
              }`}
              style={{ height: `${(log.score / 10) * 100}%`, minHeight: '4px' }}
            />
            <span className="text-[10px] text-gray-400 mt-1">{log.date.slice(5)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const LibraryView = ({ isPremium, onUnlock }: { isPremium: boolean; onUnlock: () => void }) => {
  const [filter, setFilter] = useState<'All' | 'Supine' | 'Prone' | 'Side Lying' | 'Quadruped' | 'MDT'>('All');

  const libraryItems = Object.values(DECISION_TREE).filter(
    (node) => node.type === 'video' && node.libraryCategory
  );

  const filteredItems =
    filter === 'All' ? libraryItems : libraryItems.filter((item) => item.libraryCategory === filter);

  return (
    <div className="min-h-screen bg-gray-50 pb-20">
      <div className="bg-white border-b sticky top-0 z-30 p-4">
        <h2 className="text-2xl font-bold text-gray-900 mb-4 flex items-center gap-2">
          <Library className="text-blue-600" /> Movement Library
        </h2>

        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
          {['All', 'Supine', 'Prone', 'Side Lying', 'Quadruped', 'MDT'].map((cat) => (
            <button
              key={cat}
              onClick={() => setFilter(cat as any)}
              className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
                filter === cat ? 'bg-blue-600 text-white shadow-md' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4 grid md:grid-cols-2 gap-4 max-w-5xl mx-auto">
        {!isPremium && (
          <div className="col-span-full bg-gradient-to-r from-indigo-600 to-purple-700 rounded-xl p-6 text-white shadow-lg mb-4">
            <div className="flex justify-between items-center">
              <div>
                <h3 className="font-bold text-xl mb-1">Unlock "God Mode"</h3>
                <p className="text-indigo-100 text-sm">Access the full DNS & MDT exercise library.</p>
              </div>
              <button
                onClick={onUnlock}
                className="bg-white text-indigo-700 px-4 py-2 rounded-lg font-bold hover:bg-indigo-50 transition-colors"
              >
                Upgrade
              </button>
            </div>
          </div>
        )}

        {filteredItems.map((item) => (
          <div
            key={item.id}
            className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden group hover:shadow-md transition-all"
          >
            <div className="aspect-video bg-gray-100 relative flex items-center justify-center">
              {item.isPremium && !isPremium ? (
                <div className="absolute inset-0 bg-gray-900/60 flex flex-col items-center justify-center text-white backdrop-blur-sm z-10">
                  <Lock size={32} className="mb-2" />
                  <span className="text-xs font-bold uppercase tracking-wider">Premium Content</span>
                </div>
              ) : (
                <Play size={40} className="text-gray-400 group-hover:text-blue-600 transition-colors" />
              )}

              <img
                src="/api/placeholder/400/225"
                alt={item.text ?? 'Exercise'}
                className="w-full h-full object-cover mix-blend-multiply opacity-50"
              />
            </div>

            <div className="p-4">
              <div className="flex justify-between items-start mb-2">
                <span className="text-xs font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded">
                  {item.libraryCategory}
                </span>
                {item.isPremium && (
                  <span className="text-xs text-amber-600 font-medium flex items-center gap-1">
                    <Activity size={12} /> Pro
                  </span>
                )}
              </div>

              <h3 className="font-bold text-gray-900 mb-1">{item.text}</h3>
              <p className="text-xs text-gray-500 line-clamp-2">{item.description}</p>

              <button
                onClick={() => {
                  if (item.isPremium && !isPremium) onUnlock();
                }}
                className="mt-4 w-full border border-gray-200 text-gray-600 text-sm font-medium py-2 rounded-lg hover:bg-gray-50 transition-colors"
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
  const [showTerms, setShowTerms] = useState(false);
  const [hasAgreedToTerms, setHasAgreedToTerms] = useState(false);
  const [pendingView, setPendingView] = useState<'landing' | 'assessment' | 'dashboard' | 'paywall' | 'library' | 'settings' | null>(null);
  const [simulatedTime, setSimulatedTime] = useState<number>(Date.now());
  const [isPlaying, setIsPlaying] = useState(false);

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
          if (typeof data.hasAgreedToTerms === 'boolean') setHasAgreedToTerms(data.hasAgreedToTerms);
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

  const saveUserData = async (updates: Partial<UserData>) => {
    if (!auth || !db || !auth.currentUser) return;
    const uid = auth.currentUser.uid;
    const docRef = doc(db, 'artifacts', appId, 'users', uid, 'userData', 'main');
    await setDoc(docRef, updates, { merge: true });
  };

  const handleSavePainLog = (entry: PainLogEntry) => {
    const newLog = [...painLog, entry];
    setPainLog(newLog);
    saveUserData({ painLog: newLog });
  };

  const handleResetJourney = async () => {
    const updates: Partial<UserData> = {
      activeJourney: null,
      activePrescriptions: [],
      history: [],
      currentNodeId: 'start',
    };
    await saveUserData(updates);

    setActiveJourney(null);
    setActivePrescriptions([]);
    setHistory([]);
    setCurrentNodeId('start');
    setCurrentView('dashboard');
    setIsPlaying(false);
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
    setHasAgreedToTerms(false);
    setCurrentView('landing');
    setIsPlaying(false);
  };

  const attemptNavigation = (targetView: 'assessment' | 'dashboard' | 'library') => {
    if (hasAgreedToTerms) {
      setCurrentView(targetView);
    } else {
      setPendingView(targetView);
      setShowTerms(true);
    }
  };

  const handleTermsAgree = () => {
    setHasAgreedToTerms(true);
    setShowTerms(false);
    saveUserData({ hasAgreedToTerms: true });

    if (pendingView) {
      setCurrentView(pendingView as any);
      setPendingView(null);
    }
  };

  const handleTermsDecline = () => {
    setShowTerms(false);
    setPendingView(null);
  };

  const handleOptionClick = (nextId: string) => {
    const nextNode = DECISION_TREE[nextId];

    if (!nextNode) {
      console.error(`Decision tree missing node: ${nextId}`);
      return;
    }

    if (nextNode.isPremium && !isPremium) {
      setCurrentNodeId(nextId);
      setCurrentView('paywall');
      return;
    }

    const updates: Partial<UserData> = { currentNodeId: nextId };

    if (nextNode.journeyName) {
      setActiveJourney(nextNode.journeyName);
      updates.activeJourney = nextNode.journeyName;
    }

    if (nextNode.type === 'video') {
      const newPrescriptions = [...activePrescriptions.filter((id) => id !== nextId), nextId];
      setActivePrescriptions(newPrescriptions);
      updates.activePrescriptions = newPrescriptions;
    }

    const newHistory = [...history, currentNodeId];
    setHistory(newHistory);
    updates.history = newHistory;

    setCurrentNodeId(nextId);
    setIsPlaying(false);

    saveUserData(updates);
  };

  const handleUpgrade = () => {
    setIsPremium(true);
    setCurrentView('dashboard');
    saveUserData({ isPremium: true });
  };

  const LandingPage = () => (
    <div className="flex flex-col min-h-screen bg-white">
      <header className="flex justify-between items-center p-6 border-b sticky top-0 z-50 bg-white/80 backdrop-blur-md border-gray-100">
        <div className="flex items-center gap-2">
          <img
            src="/logo.png"
            alt="NeuroActive"
            className="h-10 w-auto object-contain"
            onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/logo.png'; }}
          />
          <span className="text-xl font-bold text-gray-900">NeuroActive</span>
        </div>
        <button onClick={() => attemptNavigation('dashboard')} className="text-sm font-semibold text-gray-600 hover:text-blue-600">
          Login
        </button>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-gradient-to-b from-blue-50 to-white">
        <img
          src="/logo.png"
          alt="NeuroActive"
          className="h-24 w-auto object-contain mb-8"
          onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/logo.png'; }}
        />
        <h1 className="text-4xl md:text-5xl font-extrabold text-gray-900 mb-6">
          Recover Smarter with <span className="text-blue-600">DNS & MDT</span>
        </h1>
        <p className="text-lg text-gray-600 max-w-2xl mb-8">Clinical grade self-assessment and rehabilitation.</p>
        <button
          onClick={() => attemptNavigation('dashboard')}
          className="bg-blue-600 text-white px-8 py-4 rounded-full font-bold text-lg shadow-lg hover:bg-blue-700 transition-all flex items-center gap-2"
        >
          Start Your Recovery <ChevronRight />
        </button>
      </main>
    </div>
  );

  const Paywall = () => (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="bg-white max-w-lg w-full rounded-2xl overflow-hidden shadow-2xl relative">
        <div className="bg-gradient-to-r from-blue-600 to-indigo-700 p-8 text-white text-center">
          <Lock className="mx-auto mb-4 opacity-80" size={48} />
          <h2 className="text-3xl font-bold mb-2">Unlock God Mode</h2>
          <p className="opacity-90">Access the entire DNS Developmental Library and all advanced protocols.</p>
        </div>
        <div className="p-8 space-y-6">
          <button
            onClick={handleUpgrade}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-xl shadow-md transition-all flex justify-center items-center gap-2"
          >
            <CreditCard size={20} /> Start 7-Day Free Trial
          </button>
          <button
            onClick={() => setCurrentView('dashboard')}
            className="w-full mt-3 text-gray-500 text-sm hover:text-gray-700"
          >
            No thanks, take me back
          </button>
        </div>
      </div>
    </div>
  );

  const Dashboard = () => {
    const today = new Date().toISOString().split('T')[0];
    const todayLog = painLog.find((log) => log.date === today);

    return (
      <div className="min-h-screen bg-gray-50 pb-20">
        <div className="bg-white border-b sticky top-0 z-30">
          <div className="max-w-5xl mx-auto px-6 py-4 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <img
                src="/logo.png"
                alt="NeuroActive"
                className="h-8 w-auto object-contain"
                onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/logo.png'; }}
              />
              <span className="font-bold text-gray-900">NeuroActive</span>
            </div>
            <div className="flex items-center gap-4">
              {!isPremium && (
                <button
                  onClick={() => setCurrentView('paywall')}
                  className="text-xs font-bold bg-gradient-to-r from-orange-400 to-pink-500 text-white px-3 py-1.5 rounded-full hover:shadow-md transition-all"
                >
                  UPGRADE
                </button>
              )}
              <button
                onClick={() => setCurrentView('settings')}
                className="bg-gray-100 p-2 rounded-full hover:bg-gray-200 transition-colors"
              >
                <User size={20} className="text-gray-600" />
              </button>
            </div>
          </div>
        </div>

        <div className="max-w-5xl mx-auto p-6 space-y-8">
          <div className="bg-white p-8 rounded-2xl shadow-sm border border-gray-100 flex flex-col md:flex-row items-center justify-between gap-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900 mb-2">Welcome back.</h1>
              <p className="text-gray-600">
                You are currently on the <span className="font-bold text-blue-600">{activeJourney || 'General'}</span> track.
              </p>
            </div>
            <button
              onClick={() => { setHistory([]); setCurrentNodeId('start'); setCurrentView('assessment'); setIsPlaying(false); }}
              className="bg-blue-600 text-white px-6 py-3 rounded-lg font-semibold shadow hover:bg-blue-700 transition-colors"
            >
              New Assessment
            </button>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            <PainTracker onSaveLog={handleSavePainLog} existingLog={todayLog} />
            <PainGraph logs={painLog} />
          </div>

          <div className="bg-gradient-to-br from-gray-900 to-gray-800 rounded-2xl p-6 text-white shadow-lg flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="bg-white/10 p-3 rounded-full">
                <Library size={24} />
              </div>
              <div>
                <h3 className="font-bold text-lg">Movement Library</h3>
                <p className="text-gray-300 text-sm">Browse DNS & MDT exercises by position.</p>
              </div>
            </div>
            <button
              onClick={() => setCurrentView('library')}
              className="bg-white text-gray-900 px-4 py-2 rounded-lg font-bold text-sm hover:bg-gray-100"
            >
              Browse
            </button>
          </div>

          {activePrescriptions.length > 0 && (
            <div className="bg-indigo-50 p-6 rounded-2xl border border-indigo-100">
              <div className="flex items-center gap-2 mb-4">
                <ClipboardList className="text-indigo-600" />
                <h3 className="font-bold text-lg text-indigo-900">My Prescription</h3>
              </div>

              <div className="space-y-3">
                {activePrescriptions.map((id) => {
                  const node = DECISION_TREE[id];
                  if (!node) return null;
                  return (
                    <div key={id} className="bg-white p-4 rounded-lg shadow-sm flex justify-between items-center">
                      <div>
                        <h4 className="font-bold text-gray-800">{node.text}</h4>
                        {node.prescriptionFrequency && (
                          <div className="text-xs text-indigo-600 font-bold bg-indigo-50 inline-block px-2 py-1 rounded mt-1">
                            {node.prescriptionFrequency}
                          </div>
                        )}
                      </div>
                      <Play size={20} className="text-gray-400" />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const VideoPlayer = ({ nodeId }: { nodeId: string }) => {
    const data = DECISION_TREE[nodeId];

    const getVimeoSrc = (id: string) => {
      const separator = id.includes('?') ? '&' : '?';
      return `https://player.vimeo.com/video/${id}${separator}autoplay=1&title=0&byline=0&portrait=0&muted=1&playsinline=1&loop=1`;
    };

    if (!data || !data.videoId) return null;

    return (
      <div className="mb-6">
        <div className="bg-black aspect-video rounded-xl overflow-hidden shadow-lg relative">
          {isPlaying ? (
            <iframe
              src={getVimeoSrc(data.videoId)}
              className="w-full h-full"
              frameBorder="0"
              allow="autoplay; fullscreen; picture-in-picture"
              allowFullScreen
            />
          ) : (
            <button
              onClick={() => setIsPlaying(true)}
              className="w-full h-full relative flex items-center justify-center group"
            >
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent z-10" />
              <img
                src="/api/placeholder/800/450"
                alt="Exercise Thumbnail"
                className="w-full h-full object-cover opacity-60 group-hover:opacity-40 transition-opacity"
              />
              <div className="absolute z-20 bg-white/20 backdrop-blur-sm p-4 rounded-full border border-white/30 group-hover:scale-110 transition-transform">
                <Play className="text-white fill-current" size={32} />
              </div>
            </button>
          )}
        </div>

        <div className="mt-3 text-center space-y-1">
          <a
            href={`https://vimeo.com/${data.videoId.split('?')[0]}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-blue-600 transition-colors"
          >
            <ExternalLink size={12} /> Test Link: Watch on Vimeo
          </a>
        </div>
      </div>
    );
  };

  const AssessmentView = () => {
    const currentNode = DECISION_TREE[currentNodeId];

    if (!currentNode) {
      return (
        <div className="min-h-screen bg-gray-50 p-6">
          <div className="max-w-2xl mx-auto bg-white p-6 rounded-xl border">
            <h2 className="text-xl font-bold text-red-700">Missing Node</h2>
            <p className="text-gray-600 mt-2">
              The decision tree does not contain a node with id: <span className="font-mono">{currentNodeId}</span>
            </p>
            <button
              onClick={() => { setCurrentNodeId('start'); setHistory([]); }}
              className="mt-4 bg-blue-600 text-white px-4 py-2 rounded-lg font-semibold"
            >
              Go to start
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-gray-50 pb-20">
        <div className="bg-white shadow-sm p-4 sticky top-0 z-30 flex items-center justify-between">
          <button
            onClick={() => {
              if (history.length > 0) {
                setCurrentNodeId(history[history.length - 1]);
                setHistory((prev) => prev.slice(0, -1));
                setIsPlaying(false);
              } else {
                setCurrentView('dashboard');
                setIsPlaying(false);
              }
            }}
            className="text-gray-500 hover:text-gray-900 flex items-center gap-1"
          >
            <ArrowLeft size={20} /> Back
          </button>
          <div className="font-semibold text-gray-700">Assessment</div>
          <div className="w-16"></div>
        </div>

        <div className="max-w-2xl mx-auto p-6 mt-6">
          <div className="bg-white p-8 rounded-2xl shadow-sm border border-gray-100 text-center mb-8">
            <h2 className="text-2xl font-bold text-gray-900 mb-4">{currentNode.text}</h2>
            <p className="text-gray-600 mb-6">{currentNode.description}</p>

            {/* You can re-enable this whenever you want */}
            {/* <CentralizationGraphic /> */}
          </div>

          {currentNode.type === 'video' && (
            <div className="mb-6">
              <VideoPlayer nodeId={currentNodeId} />
            </div>
          )}

          {currentNode.type !== 'video' && (
            <div className="grid gap-4">
              {currentNode.options?.map((opt, idx) => (
                <button
                  key={idx}
                  onClick={() => handleOptionClick(opt.nextId)}
                  className="bg-white hover:bg-blue-50 border-2 border-transparent hover:border-blue-500 p-6 rounded-xl shadow-sm transition-all text-left group flex items-center justify-between"
                >
                  <span className="text-lg font-medium text-gray-700 group-hover:text-blue-700">{opt.label}</span>
                  <ChevronRight className="text-gray-300 group-hover:text-blue-500" />
                </button>
              ))}
            </div>
          )}

          {currentNode.type === 'video' && (
            <div className="rounded-xl p-6 bg-blue-50 border border-blue-100">
              <h3 className="font-bold text-gray-900 mb-4">Clinical Check-In</h3>
              <div className="grid gap-3">
                {currentNode.options?.map((opt, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleOptionClick(opt.nextId)}
                    className="bg-white p-4 rounded-lg border border-blue-100 hover:border-blue-300 hover:shadow-md text-left transition-all flex justify-between items-center group"
                  >
                    <span className="font-medium text-gray-700 group-hover:text-blue-700">{opt.label}</span>
                    <ChevronRight className="text-gray-400 group-hover:text-blue-500" size={20} />
                  </button>
                ))}
              </div>
            </div>
          )}
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
      {currentView === 'dashboard' && <Dashboard />}
      {currentView === 'settings' && (
        <SettingsView
          isPremium={isPremium}
          onBack={() => setCurrentView('dashboard')}
          onLogout={handleLogout}
          onReset={handleResetJourney}
          onUpgrade={handleUpgrade}
        />
      )}
      {currentView === 'library' && <LibraryView isPremium={isPremium} onUnlock={() => setCurrentView('paywall')} />}
      <DevTimeSkip />
    </>
  );
}
