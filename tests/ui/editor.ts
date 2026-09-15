import { expect, type Locator } from "@playwright/test";

/** Read Monaco's public viewport API; no React internals or hidden legacy DOM. */
export async function editorState(surface:Locator,side:"old"|"new"|"unified"="unified") {
  return surface.evaluate(async(node,side)=>{
    // Vite serves the same locally bundled module used by the reader.
    const {monaco}=await import(/* @vite-ignore */ "/src/monaco-runtime.ts");
    const editors=monaco.editor.getEditors();
    const editor=editors.find((e:any)=>node.contains(e.getDomNode())&&(e.getDomNode()?.closest("[data-code-side]")?.getAttribute("data-code-side")===side));
    const range=editor?.getVisibleRanges()[0],model=editor?.getModel();if(!range||!model)return null;
    const number=range.startLineNumber,label=editor.getRawOptions().lineNumbers;
    return {key:typeof label==="function"?label(number).trim().replace(/\s+/g," "):String(number),offset:Math.round(editor.getScrollTop()-editor.getTopForLineNumber(number)),top:editor.getScrollTop(),left:editor.getScrollLeft(),width:editor.getScrollWidth()};
  },side);
}
export async function setEditorScroll(surface:Locator,position:{scrollTop?:number;scrollLeft?:number},side:"old"|"new"|"unified"="unified") {
  await expect.poll(()=>editorState(surface,side)).not.toBeNull();
  await surface.evaluate(async(node,{position,side})=>{
    const {monaco}=await import(/* @vite-ignore */ "/src/monaco-runtime.ts");
    const editor=monaco.editor.getEditors().find((e:any)=>node.contains(e.getDomNode())&&e.getDomNode()?.closest("[data-code-side]")?.getAttribute("data-code-side")===side);
    editor.setScrollPosition(position);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  },{position,side});
}
export async function visibleSourcePosition(surface:Locator){const value=await editorState(surface);return value?{key:value.key,offset:value.offset}:null;}
