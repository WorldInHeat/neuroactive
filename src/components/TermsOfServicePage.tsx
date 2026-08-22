// src/components/TermsOfServicePage.tsx
// Text is verbatim from the finalized Terms of Service — do not rewrite, summarize, or
// otherwise alter the wording here. Structure (headings) is presentational only.
import LegalPageLayout, { LegalSection } from './LegalPageLayout';

export default function TermsOfServicePage() {
  return (
    <LegalPageLayout title="Terms of Service — NeuroActive App" lastUpdated="August 16, 2026">
      <p className="text-[#c3d0e0] text-base leading-relaxed">
        These Terms govern your use of the NeuroActive app. By creating an account, purchasing a program, or using
        the app, you agree to these Terms.
      </p>

      <LegalSection number={1} title="Eligibility">
        <p>
          You must be at least 13 years old to use NeuroActive. If you are under the age of majority where you
          live, you may use NeuroActive only with the permission and supervision of a parent or legal guardian. By
          permitting a minor to use NeuroActive, the parent or legal guardian agrees to these Terms on the minor's
          behalf.
        </p>
      </LegalSection>

      <LegalSection number={2} title="Educational Purpose">
        <p>
          The app, including the 12-Week DNS Foundations program, is provided for educational and informational
          purposes and is not a substitute for individualized evaluation, diagnosis, treatment, or professional
          healthcare advice. Use of the app and communications through app support channels do not create a
          doctor-patient relationship. If you separately receive professional healthcare services from Dr. Adam
          Bruene through a clinical practice, that relationship is governed separately from your use of
          NeuroActive.
        </p>
      </LegalSection>

      <LegalSection number={3} title="Not for Emergencies">
        <p>
          The app is not an emergency medical service. If you believe you may be experiencing a medical emergency,
          seek immediate care through appropriate emergency services.
        </p>
      </LegalSection>

      <LegalSection number={4} title="Assumption of Risk">
        <p>
          Physical movement and exercise carry inherent risk, including soreness, aggravation of an existing
          condition, or injury. By using the app, you voluntarily assume these risks to the extent permitted by
          law. Use reasonable judgment, and stop and seek appropriate care if you experience severe, rapidly
          worsening, or concerning symptoms.
        </p>
      </LegalSection>

      <LegalSection number={5} title="Individual Results Vary">
        <p>We do not guarantee any specific outcome, including pain reduction or injury prevention.</p>
      </LegalSection>

      <LegalSection number={6} title="Accounts">
        <p>You're responsible for keeping your sign-in credentials secure and for activity that occurs through your account.</p>
      </LegalSection>

      <LegalSection number={7} title="Payment">
        <p>
          The purchase price is displayed before checkout. Unless expressly stated otherwise at checkout, your
          purchase is a one-time payment, not a recurring subscription.
        </p>
      </LegalSection>

      <LegalSection number={8} title="Program Access">
        <p>
          Purchasing the program unlocks its content progressively, one day at a time, rather than granting access
          to all content immediately.
        </p>
      </LegalSection>

      <LegalSection number={9} title="Refunds">
        <p>
          If you're not satisfied, you may request a refund within 14 days of purchase by contacting
          DrB@neuroactivehealth.com. Refund requests submitted within that 14-day period will be honored. After 14
          days, refunds may be granted at our discretion. This policy does not limit any rights you may have under
          applicable law.
        </p>
      </LegalSection>

      <LegalSection number={10} title="License to Use">
        <p>
          We grant you a personal, non-transferable license to access the program for your own use. You may not
          share your account, redistribute program content, or reproduce it without permission.
        </p>
      </LegalSection>

      <LegalSection number={11} title="Prohibited Use">
        <p>You agree not to misuse the app, interfere with its operation, or use it unlawfully.</p>
      </LegalSection>

      <LegalSection number={12} title="Third-Party Services">
        <p>
          The app uses Stripe for payments and Vimeo for video delivery. Your use of those features is also
          subject to those providers' own terms.
        </p>
      </LegalSection>

      <LegalSection number={13} title="Disclaimer of Warranties">
        <p>The app is provided "as is," without warranties of any kind, express or implied.</p>
      </LegalSection>

      <LegalSection number={14} title="Limitation of Liability">
        <p>
          To the fullest extent permitted by law, NeuroActive Health & Fitness will not be liable for indirect,
          incidental, or consequential damages arising from your use of the app. Nothing here limits liability that
          cannot be limited under applicable law.
        </p>
      </LegalSection>

      <LegalSection number={15} title="Indemnification">
        <p>
          You agree to indemnify and hold harmless NeuroActive Health & Fitness from claims arising from your
          misuse of the app or violation of these Terms.
        </p>
      </LegalSection>

      <LegalSection number={16} title="Termination">
        <p>We may suspend or terminate your account for violation of these Terms.</p>
      </LegalSection>

      <LegalSection number={17} title="Governing Law">
        <p>These Terms are governed by the laws of the State of Illinois, without regard to conflict-of-law principles.</p>
      </LegalSection>

      <LegalSection number={18} title="Severability">
        <p>If any provision is found unenforceable, the remaining provisions stay in effect.</p>
      </LegalSection>

      <LegalSection number={19} title="Changes to These Terms">
        <p>
          For material changes — including to payment terms, dispute rights, data practices, or liability
          provisions — we'll provide reasonable notice, and where legally required, obtain your affirmative
          consent, before the change takes effect. For minor changes, continued use after the update constitutes
          acceptance.
        </p>
      </LegalSection>
    </LegalPageLayout>
  );
}
