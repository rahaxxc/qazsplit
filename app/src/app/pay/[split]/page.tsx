import { AppShell } from "@/components/app-shell";
import { SplitPayment } from "@/components/split-payment";

export default async function PayPage({
  params,
}: {
  params: Promise<{ split: string }>;
}) {
  const { split } = await params;
  return (
    <AppShell>
      <SplitPayment key={split} splitAddress={split} />
    </AppShell>
  );
}

