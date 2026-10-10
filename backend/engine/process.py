"""External engine process: one long-lived process per dataset, graph loaded once.

The engine binary is started in server mode and speaks a line protocol:
it prints READY once the graph is loaded, then answers one request per
stdin line with one JSON line followed by ---END---.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess

from .base import EngineTimeout, QueryEngine

logger = logging.getLogger(__name__)

_READY_TIMEOUT = 120  # seconds to wait for grid loading + READY signal
_END_SENTINEL = "---END---"
_NEIGHBORHOOD_CMD = "NEIGHBORHOOD "  # must match the engine's server mode

# The daemon answers with the whole result document on ONE line.  asyncio's
# default StreamReader limit is 64 KiB, and readline() raises
# "Separator is found, but chunk is longer than limit" past it -- which a large
# sample set or a wide neighbourhood exceeds easily.  Give the pipes room.
_STREAM_LIMIT = 64 * 1024 * 1024

# How long a late answer to a timed-out non-fatal request may still take before
# the daemon is declared genuinely stuck and killed.
_RESYNC_TIMEOUT = 120


class ProcessEngine(QueryEngine):
    """Manages persistent engine processes using --server mode.

    Each dataset gets its own daemon process that loads the grid once and
    accepts queries via stdin/stdout.  The first query for a dataset spawns
    the daemon; subsequent queries reuse it (sub-second latency).
    """

    def __init__(self) -> None:
        self._procs: dict[str, asyncio.subprocess.Process] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._stderr_tasks: dict[str, asyncio.Task] = {}
        # Background readers draining the late answer to a request that timed
        # out without killing the daemon; keyed by dataset.
        self._resync_tasks: dict[str, asyncio.Task] = {}
        self.current_dataset: str | None = None

    def _get_lock(self, dataset_id: str) -> asyncio.Lock:
        if dataset_id not in self._locks:
            self._locks[dataset_id] = asyncio.Lock()
        return self._locks[dataset_id]

    async def _spawn_daemon(self, dataset_id: str, config: dict) -> asyncio.subprocess.Process:
        """Spawn an engine --server process for the given dataset."""
        dataset = config["datasets"][dataset_id]
        buffers = config["buffers"]

        # --server mode doesn't need a query file, but the engine CLI expects
        # argv positions 1-10 before optional flags.  Pass /dev/null as the
        # query file placeholder (it won't be read in server mode).
        cmd = [
            config["binary"],
            dataset["grid_name"],
            dataset["grid_dir"],
            "/dev/null",  # query_file placeholder
            str(buffers["host_buf"]),
            str(buffers["dev_buf"]),
            str(buffers["visited_buf"]),
            str(buffers["host_ir_buf"]),
            str(buffers["dev_ir_buf"]),
            str(buffers["base_shard_size"]),
            "y",  # double buffering
            "--server",
            "--sample-k",
            str(config.get("sample_k", 10)),
        ]

        logger.info("Spawning engine daemon for %s: %s", dataset_id, " ".join(cmd))

        env = os.environ.copy()
        env["CUDA_VISIBLE_DEVICES"] = config.get("cuda_devices", "0")

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=config.get("project_root"),
            env=env,
            limit=_STREAM_LIMIT,
        )

        # Wait for READY signal (grid loading can take ~15-60s).
        # print_args() writes several lines to stdout before READY, so keep
        # reading until we find it.
        try:
            while True:
                raw = await asyncio.wait_for(
                    proc.stdout.readline(), timeout=_READY_TIMEOUT
                )
                if not raw:
                    # EOF — process exited before READY
                    stderr_data = await proc.stderr.read()
                    stderr_text = stderr_data.decode().strip() if stderr_data else ""
                    raise RuntimeError(
                        f"Engine daemon for {dataset_id} exited during init "
                        f"(rc={proc.returncode}): {stderr_text}"
                    )
                if raw.decode().strip() == "READY":
                    break
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise RuntimeError(
                f"Engine daemon for {dataset_id} did not send READY "
                f"within {_READY_TIMEOUT}s"
            )

        logger.info("engine daemon for %s is ready (pid=%d)", dataset_id, proc.pid)

        # Drain stderr in background to prevent pipe buffer deadlock.
        # _run_query() writes captured kernel output to stderr.
        async def _drain_stderr() -> None:
            try:
                while True:
                    line = await proc.stderr.readline()
                    if not line:
                        break
                    logger.debug("engine[%s]: %s", dataset_id, line.decode().rstrip())
            except Exception:
                pass

        self._stderr_tasks[dataset_id] = asyncio.create_task(_drain_stderr())

        return proc

    def _is_alive(self, dataset_id: str) -> bool:
        proc = self._procs.get(dataset_id)
        return proc is not None and proc.returncode is None

    async def _ensure_daemon(self, dataset_id: str, config: dict) -> asyncio.subprocess.Process:
        """Return a running daemon for the dataset, spawning if needed."""
        if self._is_alive(dataset_id):
            return self._procs[dataset_id]

        # Daemon died or never started — (re)spawn
        if dataset_id in self._procs:
            logger.warning("engine daemon for %s died (rc=%s), restarting",
                           dataset_id, self._procs[dataset_id].returncode)

        proc = await self._spawn_daemon(dataset_id, config)
        self._procs[dataset_id] = proc
        return proc

    async def run_query(
        self, query_json: str, dataset_id: str, config: dict, timeout: int = 300
    ) -> dict:
        """Send a query to the persistent daemon and return parsed JSON result.

        Args:
            query_json: JSON string of the query.
            dataset_id: Key into config["datasets"].
            config: Dict with "binary", "datasets", "buffers", "sample_k".
            timeout: Max seconds to wait for query result.

        Returns:
            Parsed JSON dict with total_count, elapsed_ms, samples, etc.

        Raises:
            RuntimeError: If the daemon fails or times out.
        """
        lock = self._get_lock(dataset_id)
        async with lock:
            parsed = await self._request(
                query_json.replace("\n", " ").strip(), dataset_id, config, timeout
            )
            self.current_dataset = dataset_id
            return parsed

    async def run_neighborhood(
        self,
        request: dict,
        dataset_id: str,
        config: dict,
        timeout: int = 60,
    ) -> dict:
        """Fetch the 1-hop neighbourhood of some vertices from the daemon.

        This is a pure host-side graph lookup inside the engine (no kernel, no query
        state), but it shares the daemon's stdin/stdout channel, so it takes the
        same per-dataset lock as run_query() and can never interleave with a
        running query.

        Args:
            request: {"vertex_ids":[int,...], "max_per_vertex":int,
                      "edge_labels":[str,...]}
                     max_per_vertex is a TOTAL per seed vertex: both directions
                     and every edge label share that one budget.
            dataset_id: Key into config["datasets"].
            config: Same dict run_query() takes.
            timeout: Max seconds to wait.  On expiry the daemon is LEFT RUNNING
                     and EngineTimeout is raised (see _request).

        Returns:
            {"vertices":[{"id","label","requested","truncated"}...],
             "edges":[{"source","target","label","undirected"}...],
             "max_per_vertex":int, "truncated":bool}
        """
        lock = self._get_lock(dataset_id)
        async with lock:
            line = _NEIGHBORHOOD_CMD + json.dumps(request, separators=(",", ":"))
            # A slow lookup must not cost the whole daemon: killing it throws
            # away a 15-60 s grid load and breaks every other client, and this
            # request is a read-only host-side grid walk with no GPU state to
            # unwind.  The late answer is drained in the background instead.
            return await self._request(
                line, dataset_id, config, timeout, kill_on_timeout=False
            )

    async def _await_resync(self, dataset_id: str) -> None:
        """Wait for a previously timed-out request's late answer to be drained.

        Callers hold the per-dataset lock, so this is the only place a stale
        response can be consumed before the next command is written.
        """
        task = self._resync_tasks.get(dataset_id)
        if task is None:
            return
        if not task.done():
            logger.info(
                "Waiting for the %s daemon to finish a timed-out request", dataset_id
            )
        try:
            # shield(): a timeout here must not cancel the drain, which owns the
            # only read side of the pipe.
            await asyncio.wait_for(asyncio.shield(task), timeout=_RESYNC_TIMEOUT + 5)
        except asyncio.TimeoutError:
            logger.error("Daemon for %s never resynchronised; killing it", dataset_id)
            proc = self._procs.pop(dataset_id, None)
            if proc is not None and proc.returncode is None:
                proc.kill()
                await proc.wait()
        except Exception as e:  # the drain reports its own failures
            logger.warning("Resync for %s ended with %s", dataset_id, e)
        finally:
            if self._resync_tasks.get(dataset_id) is task and task.done():
                self._resync_tasks.pop(dataset_id, None)

    async def _drain_until_end(
        self, dataset_id: str, proc: asyncio.subprocess.Process
    ) -> None:
        """Read and discard one pending response, up to and including ---END---."""
        try:
            while True:
                raw = await asyncio.wait_for(
                    proc.stdout.readline(), timeout=_RESYNC_TIMEOUT
                )
                if not raw:
                    logger.warning(
                        "Daemon for %s hit EOF while draining a timed-out request",
                        dataset_id,
                    )
                    if self._procs.get(dataset_id) is proc:
                        self._procs.pop(dataset_id, None)
                    return
                if raw.decode(errors="replace").strip() == _END_SENTINEL:
                    logger.info(
                        "Daemon for %s answered its timed-out request; channel is clean",
                        dataset_id,
                    )
                    return
        except asyncio.TimeoutError:
            logger.error(
                "Daemon for %s produced nothing for %ss after a timed-out request; "
                "killing it",
                dataset_id,
                _RESYNC_TIMEOUT,
            )
            if proc.returncode is None:
                proc.kill()
                await proc.wait()
            if self._procs.get(dataset_id) is proc:
                self._procs.pop(dataset_id, None)

    async def _request(
        self,
        line: str,
        dataset_id: str,
        config: dict,
        timeout: int,
        kill_on_timeout: bool = True,
    ) -> dict:
        """Write one command line, read until ---END---, return the parsed JSON.

        Caller must already hold the per-dataset lock.

        kill_on_timeout=False leaves a slow daemon running and drains its late
        answer in the background instead; the next request on that dataset waits
        for the drain before writing, so the channel can never desynchronise.
        Either way a timeout raises EngineTimeout.
        """
        # Never write a command on top of a response that is still coming.
        await self._await_resync(dataset_id)
        proc = await self._ensure_daemon(dataset_id, config)

        proc.stdin.write((line + "\n").encode())
        await proc.stdin.drain()

        # Read response lines until ---END--- sentinel
        lines: list[str] = []
        try:
            while True:
                raw = await asyncio.wait_for(proc.stdout.readline(), timeout=timeout)
                if not raw:
                    # EOF — daemon crashed (stderr is drained by bg task)
                    self._procs.pop(dataset_id, None)
                    raise RuntimeError(
                        f"Engine daemon for {dataset_id} crashed during query "
                        f"(rc={proc.returncode}); check backend logs for stderr"
                    )
                text = raw.decode().strip()
                if text == _END_SENTINEL:
                    break
                lines.append(text)
        except asyncio.TimeoutError:
            if kill_on_timeout:
                # A stuck kernel cannot be recovered: kill and remove the daemon.
                proc.kill()
                await proc.wait()
                self._procs.pop(dataset_id, None)
                raise EngineTimeout(f"Engine query timed out after {timeout}s")
            # Non-fatal: leave the daemon alone and pick its answer up later.
            self._resync_tasks[dataset_id] = asyncio.create_task(
                self._drain_until_end(dataset_id, proc)
            )
            raise EngineTimeout(
                f"Engine request timed out after {timeout}s "
                f"(daemon left running)"
            )

        # The engine prints diagnostic info to stdout before the JSON line.
        # The actual JSON result is the last non-empty line before ---END---.
        result_text = ""
        for l in reversed(lines):
            if l:
                result_text = l
                break
        if not result_text:
            raise RuntimeError("Engine daemon returned empty result")

        parsed = json.loads(result_text)

        if "error" in parsed:
            raise RuntimeError(f"Engine error: {parsed['error']}")

        return parsed

    async def preload(self, dataset_ids: list[str], config: dict) -> None:
        """Pre-spawn daemons for the given datasets (grid loaded at startup)."""
        for dataset_id in dataset_ids:
            if dataset_id not in config["datasets"]:
                logger.warning("Skipping unknown dataset for preload: %s", dataset_id)
                continue
            try:
                await self._ensure_daemon(dataset_id, config)
            except Exception as e:
                logger.error("Failed to preload %s: %s", dataset_id, e)

    async def shutdown(self) -> None:
        """Gracefully shut down all daemon processes."""
        for dataset_id, proc in list(self._procs.items()):
            if proc.returncode is not None:
                continue
            try:
                logger.info("Shutting down engine daemon for %s (pid=%d)", dataset_id, proc.pid)
                proc.stdin.write(b"QUIT\n")
                await proc.stdin.drain()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=10)
                except asyncio.TimeoutError:
                    logger.warning("Daemon for %s did not exit, killing", dataset_id)
                    proc.kill()
                    await proc.wait()
            except Exception as e:
                logger.error("Error shutting down daemon for %s: %s", dataset_id, e)
        self._procs.clear()
        for task in self._stderr_tasks.values():
            task.cancel()
        self._stderr_tasks.clear()
        for task in self._resync_tasks.values():
            task.cancel()
        self._resync_tasks.clear()

    @property
    def is_running(self) -> bool:
        """True if any daemon process is alive."""
        return any(self._is_alive(did) for did in self._procs)

    def memory_gb(self, dataset_id: str) -> dict:
        """Live memory footprint of the process that answers this dataset.

        The engine preallocates its buffers at spawn, so per-query peak is
        close to the standing footprint: host RSS (touched pages) plus the
        GPU allocation.  Returns {} when nothing can be measured.
        """
        out: dict[str, float] = {}
        proc = self._procs.get(dataset_id)
        pid = proc.pid if proc is not None and proc.returncode is None else None
        if pid is None:
            return out
        try:
            with open(f"/proc/{pid}/status") as f:
                for line in f:
                    if line.startswith("VmRSS:"):
                        out["mem_host_gb"] = round(int(line.split()[1]) / (1024 * 1024), 2)
                        break
        except OSError:
            pass
        try:
            r = subprocess.run(
                ["nvidia-smi", "--query-compute-apps=pid,used_memory",
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=5,
            )
            for ln in r.stdout.splitlines():
                parts = [x.strip() for x in ln.split(",")]
                if len(parts) >= 2 and parts[0] == str(pid):
                    out["mem_gpu_gb"] = round(int(parts[1]) / 1024, 2)
                    break
        except Exception:
            pass
        if out:
            out["engine_mem_gb"] = round(out.get("mem_host_gb", 0.0) + out.get("mem_gpu_gb", 0.0), 2)
        return out
