import type { Env } from "./env";
import type { SchedulerProbe } from "./do/scheduler-probe";

export interface TestEnv extends Env {
  SCHEDULER_PROBE: DurableObjectNamespace<SchedulerProbe>;
}
