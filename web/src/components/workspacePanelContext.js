import { createContext, useContext } from 'react';

// 右半部分工作区面板的根容器 ref。由 WorkspacePanel 提供；
// 面板内部操作触发的确认框/弹窗通过它挂载到右半部分中间（而不是整个页面中间）。
export const WorkspacePanelPanelContext = createContext(null);

export function useWorkspacePanelPanel() {
  return useContext(WorkspacePanelPanelContext);
}
