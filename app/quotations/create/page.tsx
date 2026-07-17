import { Suspense } from "react";
import DocumentCreatePage from "@/components/DocumentCreatePage";

export default function CreateQuotationPage() {
  return (
    <Suspense>
      <DocumentCreatePage variant="quotation" />
    </Suspense>
  );
}
