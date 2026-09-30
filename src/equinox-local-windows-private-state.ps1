param(
  [Parameter(Mandatory = $true)][ValidateSet('protect','verify')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][ValidateSet('file','directory')][string]$Type
)

$ErrorActionPreference = 'Stop'

function Write-Result([bool]$Safe, [string]$Reason) {
  $safeText = if ($Safe) { 'true' } else { 'false' }
  $reasonText = if ([string]::IsNullOrEmpty($Reason)) { 'null' } else { '"' + $Reason.Replace('\\', '\\\\').Replace('"', '\\"') + '"' }
  [Console]::Out.WriteLine('{"safe":' + $safeText + ',"reason":' + $reasonText + '}')
}

function Get-CurrentSid {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  if ($null -eq $identity.User) { throw 'Current Windows user SID is unavailable.' }
  return $identity.User
}

function Get-SystemSid {
  return [System.Security.Principal.SecurityIdentifier]::new([System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
}

function Get-TargetAttributes([string]$PathValue, [string]$ExpectedType) {
  $attributes = [System.IO.File]::GetAttributes($PathValue)
  if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Private state target cannot be a reparse point.' }
  $isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
  if ($ExpectedType -eq 'file' -and $isDirectory) { throw 'Private state target type mismatch.' }
  if ($ExpectedType -eq 'directory' -and -not $isDirectory) { throw 'Private state target type mismatch.' }
  return $attributes
}

function Get-PrivateAcl([string]$PathValue, [string]$ExpectedType) {
  if ($ExpectedType -eq 'directory') {
    return [System.IO.Directory]::GetAccessControl($PathValue)
  }
  return [System.IO.File]::GetAccessControl($PathValue)
}

function Set-PrivateAcl([string]$PathValue, [string]$ExpectedType) {
  $userSid = Get-CurrentSid
  $systemSid = Get-SystemSid
  if ($ExpectedType -eq 'directory') {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetOwner($userSid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($userSid, $systemSid)) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  if ($ExpectedType -eq 'directory') {
    [System.IO.Directory]::SetAccessControl($PathValue, $acl)
  } else {
    [System.IO.File]::SetAccessControl($PathValue, $acl)
  }
}

function Test-PrivateAcl([string]$PathValue, [string]$ExpectedType) {
  $userSid = Get-CurrentSid
  $systemSid = Get-SystemSid
  $acl = Get-PrivateAcl $PathValue $ExpectedType
  try {
    $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
  } catch {
    return @{ safe = $false; reason = 'owner-unresolved' }
  }
  if ($ownerSid.Value -ne $userSid.Value) { return @{ safe = $false; reason = 'owner' } }
  if (-not $acl.AreAccessRulesProtected) { return @{ safe = $false; reason = 'inheritance' } }

  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  $allowed = @($userSid.Value, $systemSid.Value)
  $seenUser = $false
  $seenSystem = $false
  foreach ($rule in $rules) {
    $sidValue = $rule.IdentityReference.Value
    if ($allowed -notcontains $sidValue) { return @{ safe = $false; reason = 'foreign-principal' } }
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { return @{ safe = $false; reason = 'deny-rule' } }
    if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { return @{ safe = $false; reason = 'insufficient-rights' } }
    if ($rule.IsInherited) { return @{ safe = $false; reason = 'inherited-rule' } }
    if ($ExpectedType -eq 'directory') {
      $required = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
      if (($rule.InheritanceFlags -band $required) -ne $required) { return @{ safe = $false; reason = 'child-inheritance' } }
    } elseif ($rule.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None) {
      return @{ safe = $false; reason = 'file-inheritance' }
    }
    if ($sidValue -eq $userSid.Value) { $seenUser = $true }
    if ($sidValue -eq $systemSid.Value) { $seenSystem = $true }
  }
  if (-not $seenUser -or -not $seenSystem) { return @{ safe = $false; reason = 'missing-owner-rule' } }
  return @{ safe = $true; reason = $null }
}

$resolvedTarget = [System.IO.Path]::GetFullPath($Target)
[void](Get-TargetAttributes $resolvedTarget $Type)
if ($Action -eq 'protect') {
  Set-PrivateAcl $resolvedTarget $Type
  [void](Get-TargetAttributes $resolvedTarget $Type)
}
$result = Test-PrivateAcl $resolvedTarget $Type
Write-Result ([bool]$result.safe) ([string]$result.reason)
