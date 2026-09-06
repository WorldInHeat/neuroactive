// src/components/PrivacyPolicyPage.tsx
// Text is verbatim from the finalized Privacy Policy — do not rewrite, summarize, or
// otherwise alter the wording here. Structure (headings/bullets) is presentational only.
import LegalPageLayout, { LegalSection, LegalList } from './LegalPageLayout';

export default function PrivacyPolicyPage() {
  return (
    <LegalPageLayout title="Privacy Policy — NeuroActive App" lastUpdated="August 16, 2026">
      <p className="text-[#c3d0e0] text-base leading-relaxed">
        This Privacy Policy explains how the NeuroActive app (neuroactivehealth.com) collects, uses, and protects
        your information. It applies specifically to the app. NeuroActive's website has its own privacy policy
        covering neuroactivefitness.com.
      </p>

      <LegalSection number={1} title="Information We Collect">
        <p>
          <strong className="text-[#f0f4f8] font-semibold">Account information.</strong> When you first use the
          app, an anonymous account is created automatically so your progress can be saved before you sign in. If
          you later sign in with Google, email/password, or an email link, your account becomes associated with your sign-in
          credentials. Progress saved before signing in will generally carry over when sign-in is completed on the
          same device. Progress from an anonymous session may not carry over when an email sign-in link is opened
          on a different device.
        </p>
        <p>If you sign in with an email link, we collect the email address you provide.</p>
        <p>
          <strong className="text-[#f0f4f8] font-semibold">Program activity.</strong> We store your progress
          through the 12-Week DNS Foundations course, including which day you're on and the date each day was
          completed.
        </p>
        <p>
          <strong className="text-[#f0f4f8] font-semibold">Purchase information.</strong> Payment is processed by
          Stripe. We do not directly collect or store your card details. We store confirmation of your purchase so
          we can grant access to paid content.
        </p>
        <p>
          <strong className="text-[#f0f4f8] font-semibold">Marketing attribution.</strong> We do not use third-party
          advertising pixels or third-party behavioral-analytics tools for marketing attribution. We collect limited
          first-party attribution information — such as the initial page visited, a referring website's hostname, and
          campaign parameters (utm_source, utm_medium, utm_campaign, utm_content, utm_term) included in a NeuroActive
          link — to understand how people discover the app. We do not collect the full referring web address through
          this feature, and attribution information is not used to determine eligibility, pricing, payment status, or
          access to course content.
        </p>
        <p>
          <strong className="text-[#f0f4f8] font-semibold">Pain and symptom assessment data.</strong> No pain,
          symptom, or assessment data is currently collected from new use of the app — this feature is present in
          our underlying platform but is not reachable or active. If you used an earlier version of the app that
          included this feature, some previously entered information may still be stored on our servers; we have
          not deleted it, though it is no longer being added to or used. If this feature is reactivated in the
          future, this policy will be updated first.
        </p>
      </LegalSection>

      <LegalSection number={2} title="How We Use Your Information">
        <LegalList>
          <li>To save and restore your program progress</li>
          <li>To verify your purchase and grant access to paid content</li>
          <li>To operate, maintain, and improve the app</li>
          <li>To respond to support requests</li>
          <li>To comply with legal obligations</li>
        </LegalList>
        <p>We do not sell your personal information to advertisers or data brokers.</p>
      </LegalSection>

      <LegalSection number={3} title="Third-Party Services">
        <p>
          The app relies on the following services to operate. We have not added third-party advertising pixels or
          third-party behavioral-analytics tools of our own — see "Marketing attribution" above for the limited
          first-party attribution information we collect ourselves. Those providers may process operational data
          (such as your device's IP address) under their own terms and privacy policies as part of delivering their
          services.
        </p>
        <LegalList>
          <li>
            <strong className="text-[#f0f4f8] font-semibold">Firebase (Google)</strong> — account authentication,
            database storage, and hosting
          </li>
          <li>
            <strong className="text-[#f0f4f8] font-semibold">Stripe</strong> — payment processing. Stripe receives
            your payment details directly; we do not.
          </li>
          <li>
            <strong className="text-[#f0f4f8] font-semibold">Vimeo</strong> — hosts and delivers the program's
            videos
          </li>
          <li>
            <strong className="text-[#f0f4f8] font-semibold">Google Fonts</strong> — loads typefaces used in the
            app
          </li>
        </LegalList>
        <p>Each provider processes information under its own privacy policy.</p>
      </LegalSection>

      <LegalSection number={4} title="Browser Storage">
        <p>
          If you request an email sign-in link, the email address you enter is stored in your browser so you do
          not have to re-enter it when completing sign-in on the same device. It is removed after successful
          sign-in. If sign-in is not completed, the email may remain in that browser's local storage.
        </p>
      </LegalSection>

      <LegalSection number={5} title="Data Retention and Deletion">
        <p>
          We retain your account and program data for as long as your account is active. To request deletion,
          contact us at DrB@neuroactivehealth.com. Because deleting your sign-in credentials and deleting your
          stored program data are two separate actions on our end, we handle deletion requests manually and will
          confirm with you once both are complete.
        </p>
      </LegalSection>

      <LegalSection number={6} title="Age">
        <p>
          NeuroActive is not intended for children under 13. If you are under the age of majority where you live,
          you should use NeuroActive only with the permission and supervision of a parent or legal guardian.
        </p>
      </LegalSection>

      <LegalSection number={7} title="Your Rights">
        <p>
          Depending on where you live, you may have rights regarding your personal information, including access,
          correction, or deletion. Contact us at DrB@neuroactivehealth.com to make a request.
        </p>
      </LegalSection>

      <LegalSection number={8} title="Changes to This Policy">
        <p>
          We'll reflect material changes here before they take effect. The "Last updated" date shows the most
          recent revision.
        </p>
      </LegalSection>
    </LegalPageLayout>
  );
}
