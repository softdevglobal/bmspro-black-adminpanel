import type { Metadata } from "next";
import AccountSetupForm from "./setup-form";

export const metadata: Metadata = {
  title: "Set your password | BMS Pro Black",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function AccountSetupPage() {
  return <AccountSetupForm />;
}
