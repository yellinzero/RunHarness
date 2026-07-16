export type FlowLayoutMode = "wide" | "medium" | "compact";

/**
 * 为不同宽度选择固定的正交反馈通道，节点尺寸变化时仍只产生直线和折线。
 * 标签坐标与线路使用同一通道计算，避免响应式布局下相互漂移。
 */
export function feedbackRoute(mode: FlowLayoutMode, sourceX: number, sourceY: number, targetX: number, targetY: number): { path: string; labelX: number; labelY: number } {
  if (mode === "wide") {
    const laneY = Math.max(sourceY, targetY) + 64;
    return {
      path: `M ${sourceX} ${sourceY} L ${sourceX} ${laneY} L ${targetX} ${laneY} L ${targetX} ${targetY}`,
      labelX: (sourceX + targetX) / 2,
      labelY: laneY - 12,
    };
  }
  if (mode === "medium") {
    const laneY = (sourceY + targetY) / 2;
    const laneX = targetX + 28;
    return {
      path: `M ${sourceX} ${sourceY} L ${sourceX} ${laneY} L ${laneX} ${laneY} L ${laneX} ${targetY} L ${targetX} ${targetY}`,
      labelX: (sourceX + laneX) / 2,
      labelY: laneY - 10,
    };
  }
  const laneX = Math.max(sourceX, targetX) + 70;
  return {
    path: `M ${sourceX} ${sourceY} L ${laneX} ${sourceY} L ${laneX} ${targetY} L ${targetX} ${targetY}`,
    labelX: laneX,
    labelY: (sourceY + targetY) / 2,
  };
}
