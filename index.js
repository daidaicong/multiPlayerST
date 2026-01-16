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

    $(document).on('click', '#coop-disconnect-btn', function() {
        if(socket){
            try {
                socket.disconnect();
            } catch(e) {
                serverDebug("Error disconnecting socket:" + e );
            }
        }
        isReady = false;
        isGenerating = false;
        myNickname = "";

        $('#coop-setup').show();    
        $('#coop-room').hide();
        $('#coop-indicator').text('🔴');
        $('#coop-player-list').empty();
        $('#coop-gen-info').text("");

        // 恢复正常的发送按钮行为
        const sendBtn = document.getElementById("send_but");
        const textarea = document.getElementById("send_textarea");
        if (sendBtn) {
            sendBtn.removeEventListener("click", coopClickHandler, { capture: true });
            // 恢复背景色
            sendBtn.style.background = ""; 
        }
        if (textarea) {
            textarea.removeEventListener("keydown", coopKeyHandler, { capture: true });
        }
        // 清空昵称输入框
        $('#coop-name-input').val('');
        // 恢复发送按钮背景色
        $("#send_but").css("background", "");
    });

    // 监听角色和预设变化，仅对主机生效,后续可增加更多变化的监听
    {
        eventSource.on(event_types.CHAT_CHANGED, function() 
        {
            if (myNickname === MASTER_NICKNAME) {
                // 延迟执行，确保状态已经更新
                setTimeout(() => {
                    onRequestState();
                }, 300);
            }
        });

        eventSource.on(event_types.PRESET_CHANGED, function() {
            if (myNickname === MASTER_NICKNAME) {
                // 延迟执行，确保状态已经更新
                setTimeout(() => {
                    onRequestState();
                }, 300);
            }
        });
    }
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
                <button id="coop-disconnect-btn" class="disconnect-btn">退出房间</button>
            </div>
        </div>
    `;
    $('body').append(html);
}

// 2. WebSocket 与 拦截激活，绑定各种和服务端交互的回调函数
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
    },300);
    
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

    socket.on("request_master_state", () => {
        if (myNickname === MASTER_NICKNAME) onRequestState();
        //onRequestState发送状态给服务端
    });
    socket.on("sync_states", (state) => {
        //通常是客户端接受回调,主机不管
        if(myNickname !== MASTER_NICKNAME) onSyncMasterState(state);

    });


    socket.on("generation_finished", () => {
        isReady = false;
        $("#send_but").css("background", "");
        if (myNickname !== MASTER_NICKNAME) $("#send_textarea").val("").trigger("input");
        saveChat();
    });
}

// 定义为命名函数，以便 removeEventListener 可以引用
function coopClickHandler(e) {
    if (myNickname === MASTER_NICKNAME) return;

    // 阻止事件继续传播，这样 ST 原生的 jQuery click 就永远收不到通知了
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    if (isGenerating) return;

    const text = String($("#send_textarea").val() || "").trim();
    if (!text && !isReady) return;

    isReady = !isReady;
    socket.emit("submit_ready", { text, isReady });
    
    // 更新 UI 状态
    $("#send_but").css("background", isReady ? "rgba(0, 255, 0, 0.4)" : "");
}

function coopKeyHandler(e) {
    if (myNickname === MASTER_NICKNAME) return;

    // 检查是否是 Enter 且无修饰键
    if (e.key === "Enter" && !e.ctrlKey && !e.shiftKey) {
        // 同样使用捕获阶段拦截
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        if (isGenerating) return;

        const text = String($("#send_textarea").val() || "").trim();
        if (!text && !isReady) return;

        isReady = !isReady;
        socket.emit("submit_ready", { text, isReady });
        $("#send_but").css("background", isReady ? "rgba(0, 255, 0, 0.4)" : "");
    }
}
// 拦截发送按钮和回车发送
function activateInterception() {
    if (myNickname === MASTER_NICKNAME) return;
    if (!myNickname) return;

    const sendBtn = document.getElementById("send_but");
    const textarea = document.getElementById("send_textarea");

    // 使用原生 addEventListener 并开启 capture: true
    // 这保证了它在任何 jQuery 事件（冒泡阶段）之前触发
    if (sendBtn) {
        sendBtn.addEventListener("click", coopClickHandler, { capture: true });
    }
    
    if (textarea) {
        textarea.addEventListener("keydown", coopKeyHandler, { capture: true });
    }
    
    //console.log("Coop interception activated (Capture Mode)");
}
/*获取房主前端当前角色卡，预设
 通知房主的，房主才会调用
 */
function onRequestState()
{
    if(!myNickname) return;
    if(myNickname !== MASTER_NICKNAME) return;

    const context = SillyTavern.getContext();
    const presetManager = context.getPresetManager();
    const state = {
        characterId: context.characterId,
        presetName: presetManager.getSelectedPresetName(), 
        timestamp: Date.now()
    };
    socket.emit("sync_state", state);
}

// 消息处理
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

// 客户端的Msg重绘
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
 * 同步主节点状态到当前客户端，只有客户端会调用
 * 该函数负责根据主节点传来的状态信息，更新当前客户端的角色和预设设置
 * 
 * state - 包含同步状态的对象
 * state.characterId - 要切换到的角色ID
 * state.presetName - 要切换到的预设名称
 */
function onSyncMasterState(state)
{
    const context = SillyTavern.getContext();
    // 检查是否已经是该角色，避免重复加载
    serverDebug("test");
    if (context.characterId !== state.characterId && state.characterId) {
        context.selectCharacterById(state.characterId);
    }
    
    serverDebug(state.presetName);
    //JQuery 选择器
    const $select = $('#settings_preset_openai');
    const targetName = state.presetName;
    // 检查下拉框是否存在
    if ($select.length === 0) {
        serverDebug("错误：找不到 #settings_preset_openai 下拉框");
        return;
    }
    // 遍历选项，按"文字内容"匹配
    const $option = $select.find('option').filter(function() {
        return $(this).text().trim() === targetName.trim();
    });

    if ($option.length > 0) {
        const val = $option.val();
        // 选中并触发酒馆原生的切换逻辑
        $select.val(val).trigger('change');
        serverDebug(`同步成功：已切换对话预设至 [${targetName}]`);
    } else {
        // 如果找不到，打印当前前 5 个选项，帮你排查是否存在名称差异
        const available = $select.find('option').slice(0, 5).map((i, el) => $(el).text()).get();
        serverDebug(`同步失败 Slave 端没找到预设 [${targetName}]。当前可用示例: ${available.join(', ')}`);
    }
}


//拖动插件的UI，小功能
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
function serverDebug(info)
{
    socket.emit("debug", info);
}