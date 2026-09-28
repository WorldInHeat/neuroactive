// src/components/LegalDisclaimer.tsx
// Medical/exercise-safety liability waiver — content unchanged from its original inline
// definition in App.tsx. Purely an exercise/safety acknowledgment (see the copy below):
// it never mentions purchase, billing, or Terms of Service for a transaction (that's a
// separate disclosure shown in Paywall.tsx, immediately above the buy button). Extracted
// into its own file so it can be required at two different points in the app — the
// legacy assessment/dashboard/library gate in App.tsx, and the DNS Foundations
// post-entitlement gate in DNSCourseView.tsx — without duplicating this text.
import { ShieldAlert } from 'lucide-react';

export default function LegalDisclaimer({ onAgree, onCancel }: { onAgree: () => void; onCancel: () => void }) {
  return (
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
              <strong>3. Consult Your Doctor First:</strong> This program involves physical movement and exercise. If
              you have a pre-existing heart, lung, or neurological condition, are pregnant or postpartum, or have had a
              recent injury or surgery you haven't been cleared for, consult a physician before beginning.
            </p>

            <p className="mb-2">
              <strong>4. Listen to Your Body:</strong> Stop immediately if you experience chest pain, dizziness,
              shortness of breath beyond normal exertion, or sharp or shooting pain. Discomfort from effort is normal;
              pain that feels wrong is not. This program is not personalized medical advice — it's based on general
              training principles, not an evaluation of your individual body or medical history.
            </p>

            <p className="mb-2">
              <strong>5. Assumption of Risk:</strong> You acknowledge that participation in these exercises involves a
              risk of injury. By continuing, you voluntarily assume all risks associated with these activities.
            </p>

            <p>
              <strong>6. Emergency:</strong> If you think you may have a medical emergency, call your doctor or 911
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
}
