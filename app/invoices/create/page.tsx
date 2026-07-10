import { Suspense } from "react";
import DocumentCreatePage from "@/components/DocumentCreatePage";

export default function CreateInvoicePage() {
  return (
    <Suspense>
      <DocumentCreatePage variant="invoice" />
    </Suspense>
  );
}
