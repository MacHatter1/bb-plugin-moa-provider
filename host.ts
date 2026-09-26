// bb-plugin-moa-provider — host artifact. The daemon imports the provider bridge from
// here and runs it on whichever machine hosts a MoA thread.
export { experimental_providerBridge } from "./src/bridge.js";
