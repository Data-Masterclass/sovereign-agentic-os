/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * Type declaration for static SVG imports (Next.js returns { src, width, height }).
 */
declare module '*.svg' {
  const content: { src: string; width?: number; height?: number };
  export default content;
}
