import { FilterBar } from "@/components/layout/FilterBar";
import { Button } from "@/components/ui/button";
import { BILL_STAGE_OPTIONS, type BillStage } from "@/lib/rep-utils";

export function StatusStagePills({
  selectedStages,
  onToggleStage,
  className,
}: {
  selectedStages: BillStage[];
  onToggleStage: (stage: BillStage) => void;
  className?: string;
}) {
  return (
    <FilterBar className={`flex flex-wrap gap-2 ${className ?? ""}`}>
      {BILL_STAGE_OPTIONS.map((stage) => {
        const selected =
          stage === "All Bills"
            ? selectedStages.length === 0
            : selectedStages.includes(stage);
        return (
          <Button
            key={stage}
            size="sm"
            variant="outline"
            className={selected ? "border-green-600 text-green-700 bg-green-50" : "border-gray-300 text-foreground"}
            onClick={() => onToggleStage(stage)}
          >
            {stage}
          </Button>
        );
      })}
    </FilterBar>
  );
}
