import { 
    saveChat, 
    addOneMessage, 
    scrollChatToBottom,
    chat,
    eventSource,
    event_types,
    characters,
    this_chid
} from "../../../script.js";

const WS_URL = "http://localhost:8001";
const MASTER_NICKNAME = "roomMaster";

let socket = null;
let isReady = false;
let isGenerating = false;
let myNickname = "";

// 1. 初始化插件
$(function () {
    // 加载配套 CSS
    $('<link>').attr({ rel: 'stylesheet', type: 'text/css', href: 'scripts/extensions/MultiUserChat/style.css' }).appendTo('head');
    
    injectHTML();
    loadSocketIO();
    //拖动
    makeDraggable($('#coop-panel'), $('.coop-title'));

    // 绑定连接按钮
    $(document).on('click', '#coop-connect-btn', function() {
        const inputName = String($('#coop-name-input').val() || "").trim();
        if (!inputName) {
            // @ts-ignore
            toastr.warning("请输入昵称");
            return;
        }
        myNickname = inputName;
        initWebSocket();
    });
});

function loadSocketIO() {
    if (window['io']) return;
    const script = document.createElement('script');
    script.src = "https://cdn.socket.io/4.7.2/socket.io.min.js";
    document.head.appendChild(script);
}

function injectHTML() {
    const html = `
        <div id="coop-panel">
            <div class="coop-title"><span>👥 多人跑团</span><span id="coop-indicator">⚪</span></div>
            <div id="coop-setup">
                <input id="coop-name-input" placeholder="输入昵称..." />
                <button id="coop-connect-btn">加入房间</button>
            </div>
            <div id="coop-room" style="display:none">
                <div class="player-list" id="coop-player-list"></div>
                <div id="coop-gen-info" style="font-size:10px; margin-top:8px; opacity:0.6"></div>
            </div>
        </div>
    `;
    $('body').append(html);
}

// 2. WebSocket 与 拦截激活
function initWebSocket() {
    // @ts-ignore
    socket = window['io'](WS_URL);

    socket.on("connect", () => {
        socket.emit("join", myNickname);
        $('#coop-setup').hide();
        $('#coop-room').show();
        $('#coop-indicator').text('🟢');
        
        // 【核心】连接后激活拦截
        activateInterception();
    });

    socket.on("update_room", (data) => {
        isGenerating = data.isGenerating;
        const $list = $('#coop-player-list').empty();
        data.players.forEach(p => {
            $list.append(`<div class="player-item"><span>${p.nickname}</span><span class="${p.isReady ? 'status-ready' : 'status-wait'}">${p.isReady ? 'READY' : '...'}</span></div>`);
        });
        $('#coop-gen-info').text(data.masterOnline ? "房主已在线" : "等待房主上线...");
    });

    socket.on("trigger_send", (data) => {
        if (myNickname === MASTER_NICKNAME) handleMasterSend(data.prompt);
    });

    socket.on("stream_update", (data) => {
        if (myNickname !== MASTER_NICKNAME) renderStreamingMessage(data.fullText);
    });

    socket.on("generation_finished", () => {
        isReady = false;
        $("#send_but").css("background", "");
        if (myNickname !== MASTER_NICKNAME) $("#send_textarea").val("").trigger("input");
        saveChat();
    });
}

function activateInterception() {
    if (myNickname === MASTER_NICKNAME) return;

    const $sendBtn = $("#send_but");
    const $textarea = $("#send_textarea"); 
    // 拦截按钮发送
    $sendBtn.off("click").on("click", function (e) {
        e.preventDefault();
        e.stopImmediatePropagation();

        if (isGenerating) return;

        const text = String($("#send_textarea").val() || "").trim();
        if (!text && !isReady) return;

        isReady = !isReady;
        socket.emit("submit_ready", { text, isReady });
        $sendBtn.css("background", isReady ? "rgba(0, 255, 0, 0.4)" : "");
    });
    
    //  拦截回车发送
    $textarea.off("keydown.coop").on("keydown.coop", function (e) {
        // 检查是否是Enter键且没有按下Ctrl或Shift（SillyTavern通常是Ctrl+Enter换行）
        if (e.key === "Enter" && !e.ctrlKey && !e.shiftKey) {
            e.preventDefault();
            e.stopImmediatePropagation();

            if (isGenerating) return;

            const text = String($textarea.val() || "").trim();
            if (!text && !isReady) return;

            isReady = !isReady;
            socket.emit("submit_ready", { text, isReady });
            $sendBtn.css("background", isReady ? "rgba(0, 255, 0, 0.4)" : "");
            
            return false;
        }
    });
}

// 3. 消息处理
function handleMasterSend(prompt) 
{
    $("#send_textarea").val(prompt).trigger("input");
    $("#send_but").trigger("click"); // 触发 ST 原生发送

    let lastSentText = ""; // 记录上次发送的文本，避免重复发送

    const observer = new MutationObserver(() => {
        const $lastMes = $(".mes.last_mes .mes_text").last();
        if ($lastMes.length > 0) {
            const text = $lastMes.text();
            // 过滤掉 "…" 或其他占位符内容
            if (text && text !== lastSentText && text.trim() !== '…' && text.trim() !== '') {
                //console.log("[UI_Debug MultiUserCoop] 房主获取到完整消息：", text);
                lastSentText = text;
                socket.emit("stream_data", { fullText: text });
            }
        }
    });
    observer.observe(document.getElementById("chat"), { childList: true, subtree: true, characterData: true });

    const endCheck = setInterval(() => {
        if ($("#send_but").is(":visible") && !$(".st-stop-button").length) {
            socket.emit("stream_end");
            observer.disconnect();
            clearInterval(endCheck);
        }
    }, 500);
}

function renderStreamingMessage(text) 
{
    // 创建新的AI回复消息（与前面的合作输入消息交替）
    const aiMessage = {
        name: characters[this_chid]?.name || "AI",  // 使用当前角色名
        is_user: false,  // 标记为AI消息
        send_date: new Date().toLocaleString(), // 添加时间戳
        mes: text,
        extra: { 
            is_coop: true,  // 标记为合作消息
            type: 'coop_ai_response' 
        }
    };
    
    // 添加AI回复消息到聊天历史
    chat.push(aiMessage);
    const newMessageIndex = chat.length - 1;
    addOneMessage(aiMessage);
    
    // 触发 ST 事件
    eventSource.emit(event_types.MESSAGE_RECEIVED, newMessageIndex, 'coop');
    
    scrollChatToBottom();
}

/**
 * 通用拖拽函数
 * @param {JQuery} $panel - 整个悬浮窗对象
 * @param {JQuery} $handle - 拖动把手（标题栏）
 */
function makeDraggable($panel, $handle) {
    let isDragging = false;
    let offset = { x: 0, y: 0 };

    $handle.on('mousedown', function (e) {
        isDragging = true;
        // 计算鼠标相对面板左上角的偏移
        const panelOffset = $panel.offset();
        offset.x = e.pageX - panelOffset.left;
        offset.y = e.pageY - panelOffset.top;
        
        $panel.css('opacity', '0.8'); // 拖动时增加透明度反馈
    });

    $(window).on('mousemove', function (e) {
        if (!isDragging) return;

        // 计算新位置
        let newX = e.pageX - offset.x;
        let newY = e.pageY - offset.y;

        // 简单的边界限制（防止拖出屏幕外）
        newX = Math.max(0, Math.min(window.innerWidth - $panel.outerWidth(), newX));
        newY = Math.max(0, Math.min(window.innerHeight - $panel.outerHeight(), newY));

        $panel.css({
            left: newX + 'px',
            top: newY + 'px',
            right: 'auto' // 取消之前的 right: 20px 限制
        });
    });

    $(window).on('mouseup', function () {
        if (isDragging) {
            isDragging = false;
            $panel.css('opacity', '1');
            
            // 可选：将位置保存到 localStorage
            const pos = { top: $panel.css('top'), left: $panel.css('left') };
            localStorage.setItem('coop-panel-pos', JSON.stringify(pos));
        }
    });

    // 初始位置恢复（如果之前保存过）
    const savedPos = localStorage.getItem('coop-panel-pos');
    if (savedPos) {
        const { top, left } = JSON.parse(savedPos);
        $panel.css({ top, left, right: 'auto' });
    }
}