import { AppShell } from "@/components/app-shell";
import { PaySplitForm } from "@/components/pay-split-form";

export default async function PayPage({
  params,
}: {
  params: Promise<{ split: string }>;
}) {
  const { split } = await params;
  return (
    <AppShell>
      <PaySplitForm splitAddress={split} />
    </AppShell>
  );
}

