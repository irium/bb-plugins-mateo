import { createContext } from "react";

/** Whether rows name their machine; false while every thread shares one host. */
export const HostNamesContext = createContext(true);
