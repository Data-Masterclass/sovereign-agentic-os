// Negative twin for GLUE-2: a tab reading the LiteLLM master key.
import { config } from '@core/kernel/config';
export const key = (): string => config.litellmMasterKey;
