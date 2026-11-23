using RXVision.Agent.Core.Api;
using RXVision.Agent.Core.Util;

namespace RXVision.Agent.Core.Avatars;

/// <summary>
/// The signed-in person's avatar, by ID only: what the server last said (<see cref="Mine"/>)
/// and what the icon shows now (<see cref="ShownId"/>): their stored choice, or null for the RX
/// mark, which is the default (D-85). The picture itself comes from the
/// bundle and never from the network (<see cref="AvatarLibrary"/>).
///
/// A save changes what shows at once, before the server answers, and puts it back if the
/// server does not take it. A read begun before a save finished is thrown away, so an old
/// answer never undoes a new choice. A change made anywhere else arrives as a push and is
/// read again, because a gender change also changes the library.
/// </summary>
public sealed class AvatarService
{
    private readonly ApiClient _api;
    private readonly ILog _log;
    private readonly object _gate = new();
    private MyAvatar? _mine;
    private string? _shownId;
    private string? _personName;
    private long _epoch;
    private int _saving;
    private bool _pushedWhileSaving;

    public AvatarService(ApiClient api, ILog log)
    {
        _api = api;
        _log = log;
    }

    /// <summary>What the server last said; null before its first answer.</summary>
    public MyAvatar? Mine { get { lock (_gate) return _mine; } }

    /// <summary>The avatar on show, or null for the RX mark.</summary>
    public string? ShownId { get { lock (_gate) return _shownId; } }

    /// <summary>Whose avatar this is, also before the server has answered.</summary>
    public string? PersonName { get { lock (_gate) return _personName; } }

    /// <summary>What shows changed (any thread).</summary>
    public event Action? Changed;

    /// <summary>
    /// What is known from the last session or the sign-in answer, before any read: an offline
    /// start still draws the person's own avatar.
    /// </summary>
    public void Seed(string? avatarId, string? personName)
    {
        lock (_gate)
        {
            _epoch++;
            _mine = null;
            _shownId = avatarId;
            _personName = personName;
        }
        Changed?.Invoke();
    }

    /// <summary>Signed out: nobody's avatar is on show.</summary>
    public void Reset() => Seed(null, null);

    /// <summary>GET /me/avatar. False when there was no answer: what is known stays.</summary>
    public async Task<bool> RefreshAsync(CancellationToken ct = default)
    {
        long epoch;
        lock (_gate) epoch = _epoch;
        var result = await _api.GetMyAvatarAsync(ct);
        if (!result.Ok || result.Data is not { } answer)
        {
            if (!result.Transient) _log.Warn("avatar", $"GET me/avatar: {result}");
            return false;
        }
        lock (_gate)
        {
            // A save began or ended meanwhile, or someone else signed in: not this answer's to change.
            if (epoch != _epoch) return true;
            Adopt(answer);
        }
        Changed?.Invoke();
        Remember(answer);
        return true;
    }

    /// <summary>PUT /me/avatar. Shows it at once; a save that does not take puts the old one back.</summary>
    public Task<ApiResult<MyAvatar>> SaveAsync(string avatarId, CancellationToken ct = default) =>
        ChangeAsync(avatarId, c => _api.SetMyAvatarAsync(avatarId, c), ct);

    /// <summary>DELETE /me/avatar: back to the RX mark, shown at once.</summary>
    public Task<ApiResult<MyAvatar>> ResetAsync(CancellationToken ct = default) =>
        ChangeAsync(null, c => _api.ResetMyAvatarAsync(c), ct);

    private async Task<ApiResult<MyAvatar>> ChangeAsync(string? showNow, Func<CancellationToken, Task<ApiResult<MyAvatar>>> call, CancellationToken ct)
    {
        string? before;
        lock (_gate)
        {
            before = _shownId;
            _shownId = showNow;
            _epoch++;
            _saving++;
        }
        Changed?.Invoke();

        ApiResult<MyAvatar>? result = null;
        bool readAgain;
        try
        {
            result = await call(ct);
        }
        finally
        {
            lock (_gate)
            {
                _epoch++;
                _saving--;
                if (result is { Ok: true, Data: { } saved }) Adopt(saved);
                else _shownId = _mine is not null ? _mine.ChosenAvatarId : before;
                readAgain = _pushedWhileSaving && _saving == 0;
                if (_saving == 0) _pushedWhileSaving = false;
            }
        }
        Changed?.Invoke();
        if (result.Ok && result.Data is { } answer) Remember(answer);
        // Something changed elsewhere while this was on its way: the server's last word decides.
        if (readAgain) await RefreshAsync(ct);
        return result;
    }

    /// <summary>
    /// avatar:changed about this person: updates what shows whatever a save has drawn, then
    /// reads again. A push that lands during a save waits for the save's answer.
    /// </summary>
    public void OnPushed(string? avatarId)
    {
        bool saving;
        lock (_gate)
        {
            saving = _saving > 0;
            if (saving) _pushedWhileSaving = true;
            else _shownId = AvatarChoice.Shown(avatarId);
        }
        if (saving) return;
        Changed?.Invoke();
        _ = ReadAfterPushAsync();
    }

    private async Task ReadAfterPushAsync()
    {
        try { await RefreshAsync(); }
        catch (Exception ex) { _log.Warn("avatar", "reading the avatar after a push failed", ex); }
    }

    private void Adopt(MyAvatar answer)
    {
        _mine = answer;
        _shownId = answer.ChosenAvatarId;
    }

    /// <summary>Kept with the saved session, so the next offline start draws this one.</summary>
    private void Remember(MyAvatar answer) => _api.RememberAvatar(answer.ChosenAvatarId);
}
