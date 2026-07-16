import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { feedbackRoute, type FlowLayoutMode } from "../flow-geometry";
import { useI18n } from "../i18n/provider";
import type { FlowNodeKind, ProcessFlowModel, ProcessFlowNode, WorkflowStage } from "../run-model";

type FlowNodeData = {
  index: string;
  label: string;
  status: string;
  detail?: string;
  state: ProcessFlowNode["state"];
  kind: FlowNodeKind;
  active: boolean;
};

const nodeTypes = { harness: HarnessNode };
const edgeTypes = { feedback: FeedbackEdge };
const stages: FlowNodeKind[] = ["goal", "planner", "generator", "evidence", "evaluator", "result"];
const NODE_WIDTH = 148;
const NODE_HEIGHT = 112;

export function ProcessFlow({ model, height = 240, onStageSelect }: { model: ProcessFlowModel; height?: number; onStageSelect?(stage: WorkflowStage): void }) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const built = useMemo(() => layoutFlow(model, t, width), [model, t, width]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry?.contentRect.width ?? element.clientWidth)));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  return <div ref={containerRef} className={`process-flow layout-${built.mode}`} style={{ height: Math.max(height, built.height) }} role="img" aria-label={t("run.workflow")}>
    <ReactFlow
      nodes={built.nodes}
      edges={built.edges}
      onNodeClick={(_, node) => {
        if (onStageSelect && stages.includes(node.id as FlowNodeKind)) onStageSelect(node.id as WorkflowStage);
      }}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      minZoom={0.35}
      maxZoom={1.35}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={Boolean(onStageSelect)}
      panOnDrag
      zoomOnScroll={false}
      preventScrolling={false}
      defaultEdgeOptions={{ type: "straight" }}
    >
      <Background gap={16} size={1} color="#d7ddd6" />
      <Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}

function HarnessNode({ data }: NodeProps<Node<FlowNodeData>>) {
  return <div className={`flow-node kind-${data.kind} state-${data.state}${data.active ? " is-live" : ""}`}>
    <Handle type="target" position={Position.Left} className="flow-handle" id="in" />
    <Handle type="target" position={Position.Top} className="flow-handle" id="up-in" />
    <Handle type="target" position={Position.Bottom} className="flow-handle" id="feedback-in" />
    <Handle type="target" position={Position.Right} className="flow-handle" id="right-in" />
    <Handle type="target" position={Position.Right} className="flow-handle" id="loop-in" style={{ top: "68%" }} />
    <span className="flow-index">{data.index}</span>
    <strong>{data.label}</strong>
    <small className={`flow-status state-${data.state}`}>{data.status}</small>
    {data.detail && <span className="flow-detail">{data.detail}</span>}
    <Handle type="source" position={Position.Right} className="flow-handle" id="out" />
    <Handle type="source" position={Position.Bottom} className="flow-handle" id="down-out" />
    <Handle type="source" position={Position.Top} className="flow-handle" id="up-out" />
    <Handle type="source" position={Position.Right} className="flow-handle" id="loop-out" style={{ top: "84%" }} />
    <Handle type="source" position={Position.Left} className="flow-handle" id="left-out" />
  </div>;
}

function layoutFlow(model: ProcessFlowModel, t: (key: string, vars?: Record<string, string | number>) => string, width: number): { nodes: Node<FlowNodeData>[]; edges: Edge[]; mode: FlowLayoutMode; height: number } {
  const mode: FlowLayoutMode = width > 0 && width < 720 ? "compact" : width > 0 && width < 1080 ? "medium" : "wide";
  const height = mode === "compact" ? 950 : mode === "medium" ? 500 : 300;
  const positions = stages.map((_, index) => {
    if (mode === "compact") {
      const gap = 42;
      const contentHeight = stages.length * NODE_HEIGHT + (stages.length - 1) * gap;
      return { x: Math.max(16, (width - NODE_WIDTH) / 2), y: (height - contentHeight) / 2 + index * (NODE_HEIGHT + gap) };
    }
    if (mode === "medium") {
      const column = index < 3 ? index : 5 - index;
      const columnGap = 98;
      const rowGap = 92;
      const contentWidth = 3 * NODE_WIDTH + 2 * columnGap;
      const contentHeight = 2 * NODE_HEIGHT + rowGap;
      return { x: Math.max(16, (width - contentWidth) / 2) + column * (NODE_WIDTH + columnGap), y: (height - contentHeight) / 2 + (index < 3 ? 0 : NODE_HEIGHT + rowGap) };
    }
    const margin = 24;
    const gap = Math.max(24, (Math.max(width, 1040) - 2 * margin - stages.length * NODE_WIDTH) / (stages.length - 1));
    return { x: margin + index * (NODE_WIDTH + gap), y: (height - NODE_HEIGHT) / 2 };
  });
  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  const nodes: Node<FlowNodeData>[] = stages.map((stage, index) => {
    const node: ProcessFlowNode = byId.get(stage) ?? { id: stage, kind: stage, state: "waiting", active: false };
    return {
      id: node.id,
      type: "harness",
      position: positions[index]!,
      data: {
        index: String(index + 1).padStart(2, "0"),
        label: t(`stages.${stage}`),
        status: t(`stageState.${node.state}`),
        state: node.state,
        kind: node.kind,
        active: node.active,
        ...(node.detail && node.kind !== "result" ? { detail: node.detail } : {}),
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
    };
  });
  const edges: Edge[] = model.edges.map((edge) => {
    const isLoop = edge.kind === "loop";
    const animated = Boolean(edge.animated);
    const color = animated ? "#d85d42" : isLoop ? "#b58d7d" : "#86958b";
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      className: animated ? "flow-edge-live" : isLoop ? "flow-edge-loop" : "flow-edge",
      ...(isLoop
        ? {
          sourceHandle: mode === "compact" ? "loop-out" : mode === "medium" ? "up-out" : "down-out",
          targetHandle: mode === "compact" ? "loop-in" : mode === "medium" ? "right-in" : "feedback-in",
          type: "feedback" as const,
          data: { mode },
        }
        : mode === "compact" || (mode === "medium" && edge.id === "generator->evidence")
          ? { sourceHandle: "down-out", targetHandle: "up-in", type: "straight" as const }
          : mode === "medium" && (edge.id === "evidence->evaluator" || edge.id === "evaluator->result")
            ? { sourceHandle: "left-out", targetHandle: "right-in", type: "straight" as const }
            : { sourceHandle: "out", targetHandle: "in", type: "straight" as const }),
      animated,
      label: isLoop ? t("process.loopIteration", { current: edge.iteration ?? model.loop.current, max: edge.maxIterations ?? model.loop.max }) : edge.label,
      ...(!isLoop ? { labelStyle: { fill: animated ? "#9e401f" : "#66756c", fontSize: 11, fontWeight: 600 }, labelBgStyle: { fill: animated ? "#fff7ef" : "#f7f9f5", fillOpacity: 0.95 }, labelBgPadding: [6, 4] as [number, number], labelBgBorderRadius: 4 } : {}),
      style: { stroke: color, strokeWidth: animated ? 2.8 : isLoop ? 2 : 1.6, ...(isLoop && !animated ? { strokeDasharray: "6 4" } : {}) },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
    };
  });
  return { nodes, edges, mode, height };
}

function FeedbackEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, style, label, data }: EdgeProps) {
  const mode = (data as { mode?: FlowLayoutMode } | undefined)?.mode ?? "wide";
  const { path, labelX, labelY } = feedbackRoute(mode, sourceX, sourceY, targetX, targetY);
  return <><BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} {...(style ? { style } : {})} /><EdgeLabelRenderer><div className={`feedback-edge-label mode-${mode}`} style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}>{label}</div></EdgeLabelRenderer></>;
}
