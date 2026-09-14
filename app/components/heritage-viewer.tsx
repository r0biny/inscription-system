"use client";

import { useEffect, useId, useRef, useState, type ComponentType } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Images,
  LoaderCircle,
  Maximize,
  Minimize,
  RefreshCw,
  Scaling,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import type OpenSeadragonType from "openseadragon";
import { ResetZoomIcon, type ViewerControlIconProps } from "./viewer-icons";

export type HeritageTarget = {
  id: string;
  label: string;
  crop: { x: number; y: number; size: number };
};

export type HeritageDamagePatch = {
  id: string;
  imageUrl: string;
  crop: { x: number; y: number; size: number };
};

export type HeritagePageItem = {
  id: number;
  label: string;
  thumbnailUrl: string;
  targetCount: number;
  width: number;
  height: number;
  damagePatches?: HeritageDamagePatch[];
};

export type HeritageViewportState = {
  centerX: number;
  centerY: number;
  imageZoom: number;
};

type ViewerInstance = ReturnType<typeof OpenSeadragonType>;

// The current dummy source is only 498 px wide. OSD's native-pixel default
// is lower than our fill-width view, so the next constrained zoom would snap
// backwards. Eight times native resolution keeps fill and manual zoom in one
// continuous range while retaining a finite upper bound.
const MAX_ZOOM_PIXEL_RATIO = 8;
const PAGE_THUMBNAIL_WIDTH = 62;
const PAGE_THUMBNAIL_HEIGHT = 72;

export type HeritageViewerEvent =
  | "source_zoomed"
  | "source_panned"
  | "source_global_view"
  | "source_fill_view"
  | "source_pure_mode_entered"
  | "source_pure_mode_exited"
  | "bbox_overlay_shown"
  | "bbox_overlay_hidden";

function ViewerIconControl({
  label,
  icon: Icon,
  onClick,
  active = false,
  pressed,
}: {
  label: string;
  icon: ComponentType<ViewerControlIconProps> | LucideIcon;
  onClick: () => void;
  active?: boolean;
  pressed?: boolean;
}) {
  const tooltipId = useId();

  return (
    <span className="public-viewer-action">
      <button
        type="button"
        className={active ? "is-active" : ""}
        onClick={onClick}
        aria-label={label}
        aria-describedby={tooltipId}
        aria-pressed={pressed}
      >
        <Icon size={18} strokeWidth={1.65} aria-hidden="true" />
      </button>
      <span className="public-viewer-tooltip" id={tooltipId} role="tooltip" lang="en">{label}</span>
    </span>
  );
}

export function HeritageViewer({
  imageUrl,
  imageWidth,
  imageHeight,
  targets,
  damagePatches = [],
  activeId,
  onSelect,
  skeletonSources,
  compact = false,
  onInteraction,
  initialView = "fill",
  controlsVariant = "public",
  focusTargetId,
  focusRequestKey,
  pages = [],
  activePageId,
  onPageChange,
  pageDrawerOpen,
  onPageDrawerOpenChange,
  initialViewportState,
  onViewportStateChange,
}: {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  targets: HeritageTarget[];
  damagePatches?: HeritageDamagePatch[];
  activeId: string;
  onSelect?: (id: string) => void;
  skeletonSources?: Record<string, string>;
  compact?: boolean;
  onInteraction?: (type: HeritageViewerEvent) => void;
  initialView?: "fill" | "global";
  controlsVariant?: "internal" | "public";
  focusTargetId?: string;
  focusRequestKey?: number;
  pages?: HeritagePageItem[];
  activePageId?: number;
  onPageChange?: (pageId: number) => void;
  pageDrawerOpen?: boolean;
  onPageDrawerOpenChange?: (open: boolean) => void;
  initialViewportState?: HeritageViewportState;
  onViewportStateChange?: (state: HeritageViewportState) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<ViewerInstance | null>(null);
  const moduleRef = useRef<typeof OpenSeadragonType | null>(null);
  const trackersRef = useRef<Array<{ destroy: () => void }>>([]);
  const navigatorPatchElementsRef = useRef<HTMLElement[]>([]);
  const navigatorSafetyTokenRef = useRef(0);
  const [bboxVisible, setBboxVisible] = useState(true);
  const [pureMode, setPureMode] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [internalPageDrawerOpen, setInternalPageDrawerOpen] = useState(false);

  const activePageIndex = pages.findIndex((page) => page.id === activePageId);
  const hasMultiplePages = pages.length > 1 && activePageIndex >= 0;
  const isPageDrawerOpen = pageDrawerOpen ?? internalPageDrawerOpen;

  const setPageDrawer = (open: boolean) => {
    if (pageDrawerOpen === undefined) setInternalPageDrawerOpen(open);
    onPageDrawerOpenChange?.(open);
  };

  const clearOverlays = () => {
    navigatorSafetyTokenRef.current += 1;
    trackersRef.current.forEach((tracker) => tracker.destroy());
    trackersRef.current = [];
    const navigator = viewerRef.current?.navigator;
    navigatorPatchElementsRef.current.forEach((element) => navigator?.removeOverlay(element));
    navigatorPatchElementsRef.current = [];
    viewerRef.current?.clearOverlays();
  };

  const addOverlays = () => {
    const viewer = viewerRef.current;
    const OpenSeadragon = moduleRef.current;
    if (!viewer || !OpenSeadragon) return;
    clearOverlays();

    const navigatorImages: HTMLImageElement[] = [];
    if (viewer.navigator && damagePatches.length > 0) viewer.navigator.element.style.visibility = "hidden";

    damagePatches.forEach((patch) => {
      const element = document.createElement("div");
      element.className = "osd-damage-patch";
      element.setAttribute("aria-hidden", "true");
      const image = document.createElement("img");
      image.src = patch.imageUrl;
      image.alt = "";
      element.appendChild(image);
      const rect = viewer.viewport.imageToViewportRectangle(
        patch.crop.x,
        patch.crop.y,
        patch.crop.size,
        patch.crop.size,
      );
      viewer.addOverlay({ element, location: rect, checkResize: false });

      const navigator = viewer.navigator;
      if (navigator) {
        const navigatorElement = document.createElement("div");
        navigatorElement.className = "osd-damage-patch osd-navigator-damage-patch";
        navigatorElement.setAttribute("aria-hidden", "true");
        const navigatorImage = document.createElement("img");
        navigatorImage.src = patch.imageUrl;
        navigatorImage.alt = "";
        navigatorElement.appendChild(navigatorImage);
        const navigatorRect = navigator.viewport.imageToViewportRectangle(
          patch.crop.x,
          patch.crop.y,
          patch.crop.size,
          patch.crop.size,
        );
        navigator.addOverlay({ element: navigatorElement, location: navigatorRect, checkResize: false });
        navigatorPatchElementsRef.current.push(navigatorElement);
        navigatorImages.push(navigatorImage);
      }
    });

    if (viewer.navigator && navigatorImages.length > 0) {
      const safetyToken = navigatorSafetyTokenRef.current;
      Promise.all(navigatorImages.map((image) => image.decode().then(() => image.naturalWidth > 0).catch(() => false))).then((loaded) => {
        if (safetyToken !== navigatorSafetyTokenRef.current || !loaded.every(Boolean)) return;
        viewer.navigator.element.style.visibility = "visible";
      });
    } else if (viewer.navigator) {
      viewer.navigator.element.style.visibility = "visible";
    }

    targets.forEach((target) => {
      const skeleton = skeletonSources?.[target.id];
      if (!skeleton) return;
      const element = document.createElement("div");
      element.className = "osd-skeleton-patch";
      element.setAttribute("aria-hidden", "true");
      const image = document.createElement("img");
      image.src = skeleton;
      image.alt = "";
      element.appendChild(image);
      const rect = viewer.viewport.imageToViewportRectangle(
        target.crop.x,
        target.crop.y,
        target.crop.size,
        target.crop.size,
      );
      viewer.addOverlay({ element, location: rect, checkResize: false });
    });

    if (!bboxVisible) return;

    targets.forEach((target) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = `osd-bbox ${target.id === activeId ? "is-active" : ""}`;
      element.setAttribute("aria-label", `查看${target.label}`);

      const label = document.createElement("span");
      label.textContent = target.id;
      element.appendChild(label);

      const rect = viewer.viewport.imageToViewportRectangle(
        target.crop.x,
        target.crop.y,
        target.crop.size,
        target.crop.size,
      );
      viewer.addOverlay({ element, location: rect, checkResize: false });

      const tracker = new OpenSeadragon.MouseTracker({
        element,
        clickHandler: () => {
          onSelect?.(target.id);
        },
      });
      tracker.setTracking(true);
      trackersRef.current.push(tracker);
    });
  };

  useEffect(() => {
    let cancelled = false;
    let viewer: ViewerInstance | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let opened = false;
    setReady(false);
    setLoadError(false);

    void import("openseadragon").then((module) => {
      if (cancelled || !hostRef.current) return;
      const OpenSeadragon = module.default;
      moduleRef.current = OpenSeadragon;
      viewer = OpenSeadragon({
        element: hostRef.current,
        tileSources: { type: "image", url: imageUrl, buildPyramid: true } as OpenSeadragonType.ImageTileSourceOptions,
        showNavigationControl: false,
        showNavigator: true,
        navigatorPosition: "BOTTOM_LEFT",
        navigatorAutoFade: false,
        navigatorWidth: 92,
        navigatorHeight: 132,
        homeFillsViewer: false,
        minZoomImageRatio: 0.55,
        maxZoomPixelRatio: MAX_ZOOM_PIXEL_RATIO,
        visibilityRatio: 0.08,
        constrainDuringPan: false,
        animationTime: 0.45,
        blendTime: 0.1,
        gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true },
        gestureSettingsTouch: { pinchToZoom: true, flickEnabled: true },
      });
      viewerRef.current = viewer;
      if (viewer.navigator && damagePatches.length > 0) viewer.navigator.element.style.visibility = "hidden";

      const reportViewportState = () => {
        if (!viewer || !opened || !onViewportStateChange) return;
        const center = viewer.viewport.viewportToImageCoordinates(viewer.viewport.getCenter());
        onViewportStateChange({
          centerX: center.x,
          centerY: center.y,
          imageZoom: viewer.viewport.viewportToImageZoom(viewer.viewport.getZoom()),
        });
      };

      viewer.addHandler("open", () => {
        if (initialViewportState) {
          const center = viewer?.viewport.imageToViewportCoordinates(
            initialViewportState.centerX,
            initialViewportState.centerY,
          );
          const zoom = viewer?.viewport.imageToViewportZoom(initialViewportState.imageZoom);
          if (center && zoom) {
            viewer?.viewport.zoomTo(zoom, center, true);
            viewer?.viewport.panTo(center, true);
            viewer?.viewport.applyConstraints(true);
          }
        } else if (initialView === "fill") {
          const homeZoom = viewer?.viewport.getHomeZoom() ?? 1;
          viewer?.viewport.zoomTo(Math.max(1, homeZoom), undefined, true);
          viewer?.viewport.panTo(viewer.viewport.getHomeBounds().getCenter(), true);
        } else {
          viewer?.viewport.goHome(true);
        }
        opened = true;
        reportViewportState();
        addOverlays();
        setReady(true);
        window.requestAnimationFrame(() => viewer?.forceRedraw());
      });
      viewer.addHandler("open-failed", () => {
        if (cancelled) return;
        setReady(false);
        setLoadError(true);
      });
      viewer.addHandler("zoom", () => {
        if (!opened) return;
        onInteraction?.("source_zoomed");
        reportViewportState();
      });
      viewer.addHandler("pan", () => {
        if (!opened) return;
        onInteraction?.("source_panned");
        reportViewportState();
      });

      resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!viewer || !entry || entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return;
        viewer.viewport.resize(
          new OpenSeadragon.Point(entry.contentRect.width, entry.contentRect.height),
          true,
        );
        viewer.forceRedraw();
      });
      resizeObserver.observe(hostRef.current);
    }).catch(() => {
      if (!cancelled) setLoadError(true);
    });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      clearOverlays();
      viewer?.destroy();
      viewerRef.current = null;
      moduleRef.current = null;
    };
    // The viewer is recreated only when its image changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, imageWidth, imageHeight, loadAttempt]);

  useEffect(() => {
    if (!ready) return;
    clearOverlays();
    addOverlays();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, activeId, bboxVisible, damagePatches, skeletonSources, targets]);

  useEffect(() => {
    if (!ready || !focusTargetId) return;
    const viewer = viewerRef.current;
    const target = targets.find((item) => item.id === focusTargetId);
    if (!viewer || !target) return;
    const padding = target.crop.size * 1.45;
    const x = Math.max(0, target.crop.x - padding);
    const y = Math.max(0, target.crop.y - padding);
    const width = Math.min(imageWidth - x, target.crop.size + padding * 2);
    const height = Math.min(imageHeight - y, target.crop.size + padding * 2);
    const bounds = viewer.viewport.imageToViewportRectangle(x, y, width, height);
    viewer.viewport.fitBounds(bounds, false);
  }, [focusRequestKey, focusTargetId, imageHeight, imageUrl, imageWidth, ready, targets]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      viewerRef.current?.forceRedraw();
    }, 80);
    return () => window.clearTimeout(timer);
  }, [pureMode]);

  const zoomBy = (factor: number) => {
    viewerRef.current?.viewport.zoomBy(factor);
    viewerRef.current?.viewport.applyConstraints();
  };

  const showGlobal = () => {
    viewerRef.current?.viewport.goHome(false);
    onInteraction?.("source_global_view");
  };
  const fillFrame = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.viewport.zoomTo(Math.max(1, viewer.viewport.getHomeZoom()));
    viewer.viewport.panTo(viewer.viewport.getHomeBounds().getCenter());
    onInteraction?.("source_fill_view");
  };

  const toggleBbox = () => {
    setBboxVisible((value) => {
      onInteraction?.(value ? "bbox_overlay_hidden" : "bbox_overlay_shown");
      return !value;
    });
  };

  const togglePureMode = () => {
    setPureMode((value) => {
      onInteraction?.(value ? "source_pure_mode_exited" : "source_pure_mode_entered");
      return !value;
    });
  };

  const changePage = (pageId: number) => onPageChange?.(pageId);

  return (
    <div className={`heritage-viewer-shell ${compact ? "is-compact" : ""} ${pureMode ? "is-pure-mode" : ""} ${controlsVariant === "public" ? "has-public-controls" : ""}`}>
      {controlsVariant === "public" ? (
        <div className="public-viewer-toolbar" aria-label="Image viewer controls">
          {hasMultiplePages ? (
            <div className="public-page-controls" aria-label="Page navigation">
              <button type="button" onClick={() => changePage(pages[activePageIndex + 1].id)} disabled={activePageIndex === pages.length - 1} aria-label="Next page"><ChevronLeft size={17} aria-hidden="true" /></button>
              <button type="button" className="page-overview-trigger" onClick={() => setPageDrawer(!isPageDrawerOpen)} aria-label="Open page overview" aria-expanded={isPageDrawerOpen}>
                <Images size={16} aria-hidden="true" /><span>{activePageIndex + 1} / {pages.length}</span>
              </button>
              <button type="button" onClick={() => changePage(pages[activePageIndex - 1].id)} disabled={activePageIndex === 0} aria-label="Previous page"><ChevronRight size={17} aria-hidden="true" /></button>
            </div>
          ) : <div />}
          <div className="public-viewer-controls">
            <div className="public-viewer-group">
              <ViewerIconControl label="Zoom in" icon={ZoomIn} onClick={() => zoomBy(1.35)} />
              <ViewerIconControl label="Zoom out" icon={ZoomOut} onClick={() => zoomBy(0.74)} />
              <ViewerIconControl label="Reset zoom" icon={ResetZoomIcon} onClick={showGlobal} />
              <ViewerIconControl label="Fill frame" icon={Scaling} onClick={fillFrame} />
            </div>
            <div className="public-viewer-group">
              <ViewerIconControl
                label={bboxVisible ? "Hide target regions" : "Show target regions"}
                icon={bboxVisible ? Eye : EyeOff}
                onClick={toggleBbox}
                active={bboxVisible}
                pressed={bboxVisible}
              />
            </div>
            <div className="public-viewer-group">
              <ViewerIconControl
                label={pureMode ? "Exit full screen" : "Full screen"}
                icon={pureMode ? Minimize : Maximize}
                onClick={togglePureMode}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="heritage-viewer-toolbar">
          <div className="viewer-mode-buttons">
            <button onClick={showGlobal}>全图</button>
            <button onClick={fillFrame}>满框</button>
          </div>
          <div className="viewer-mode-buttons">
            <button
              className={bboxVisible ? "is-on" : ""}
              onClick={toggleBbox}
              aria-pressed={bboxVisible}
            >
              <span className="switch-mark" /> bbox
            </button>
            <button onClick={togglePureMode}>{pureMode ? "退出纯图" : "纯图查看"}</button>
          </div>
        </div>
      )}
      {isPageDrawerOpen && hasMultiplePages && (
        <div className="page-thumbnail-drawer" aria-label="Page overview">
          {pages.map((page, pageIndex) => {
            const thumbnailScale = Math.max(
              PAGE_THUMBNAIL_WIDTH / page.width,
              PAGE_THUMBNAIL_HEIGHT / page.height,
            );
            const thumbnailWidth = page.width * thumbnailScale;
            const thumbnailHeight = page.height * thumbnailScale;
            const thumbnailLeft = (PAGE_THUMBNAIL_WIDTH - thumbnailWidth) / 2;
            const thumbnailTop = (PAGE_THUMBNAIL_HEIGHT - thumbnailHeight) / 2;

            return (
              <button type="button" key={page.id} className={page.id === activePageId ? "is-active" : ""} onClick={() => changePage(page.id)} aria-label={`Open ${page.label}`}>
                <span className="page-thumbnail-image">
                  <img
                    className="page-thumbnail-source"
                    src={page.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    style={{
                      left: thumbnailLeft,
                      top: thumbnailTop,
                      width: thumbnailWidth,
                      height: thumbnailHeight,
                    }}
                  />
                  {page.damagePatches?.map((patch) => (
                    <img
                      className="page-thumbnail-damage-patch"
                      key={patch.id}
                      src={patch.imageUrl}
                      alt=""
                      style={{
                        left: thumbnailLeft + patch.crop.x * thumbnailScale,
                        top: thumbnailTop + patch.crop.y * thumbnailScale,
                        width: patch.crop.size * thumbnailScale,
                        height: patch.crop.size * thumbnailScale,
                      }}
                    />
                  ))}
                  {page.targetCount > 0 && <b>{page.targetCount}</b>}
                </span>
                <span>{String(pageIndex + 1).padStart(2, "0")}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="heritage-viewer-canvas" ref={hostRef} aria-label="可缩放和拖动的碑刻图像浏览器" />
      {!ready && !loadError && (
        <div className="heritage-viewer-loading" role="status" aria-live="polite">
          <LoaderCircle size={22} aria-hidden="true" />
          <span>正在加载拓片</span>
        </div>
      )}
      {loadError && (
        <div className="heritage-viewer-loading is-error" role="alert">
          <span>拓片加载失败，请检查网络后重试。</span>
          <button type="button" onClick={() => setLoadAttempt((value) => value + 1)}>
            <RefreshCw size={15} aria-hidden="true" />重新加载
          </button>
        </div>
      )}
      {controlsVariant === "internal" && (
        <div className="heritage-zoom-controls">
          <button onClick={() => zoomBy(1.35)} aria-label="放大">+</button>
          <button onClick={() => zoomBy(0.74)} aria-label="缩小">−</button>
          <button onClick={showGlobal}>回到全图</button>
        </div>
      )}
      {pureMode && <div className="pure-mode-caption">原始拓片浏览{hasMultiplePages ? ` · ${activePageIndex + 1} / ${pages.length}` : ""} · {imageWidth} × {imageHeight} px</div>}
    </div>
  );
}
