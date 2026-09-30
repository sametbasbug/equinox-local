param(
  [Parameter(Mandatory = $true)][ValidateSet('protect','verify')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][ValidateSet('file','directory')][string]$Type
)

$ErrorActionPreference = 'Stop'

function Write-Result([bool]$Safe, [string]$Reason) {
  [pscustomobject]@{ safe = $Safe; reason = $Reason } | ConvertTo-Json -Compress
}

function Get-CurrentSid {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  if ($null -eq $identity.User) { throw 'Current Windows user SID is unavailable.' }
  return $identity.User
}

function Get-SystemSid {
  return New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
}

function Assert-NormalTarget([System.IO.FileSystemInfo]$Item, [string]$ExpectedType) {
  if (($Item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Private state target cannot be a reparse point.' }
  if ($ExpectedType -eq 'file' -and $Item.PSIsContainer) { throw 'Private state target type mismatch.' }
  if ($ExpectedType -eq 'directory' -and -not $Item.PSIsContainer) { throw 'Private state target type mismatch.' }
}

function Set-PrivateAcl([System.IO.FileSystemInfo]$Item, [string]$ExpectedType) {
  $userSid = Get-CurrentSid
  $systemSid = Get-SystemSid
  if ($ExpectedType -eq 'directory') {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetOwner($userSid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($userSid, $systemSid)) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Item.FullName -AclObject $acl
}

function Test-PrivateAcl([System.IO.FileSystemInfo]$Item, [string]$ExpectedType) {
  $userSid = Get-CurrentSid
  $systemSid = Get-SystemSid
  $acl = Get-Acl -LiteralPath $Item.FullName
  try {
    $ownerSid = (New-Object System.Security.Principal.NTAccount($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier])
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

$item = Get-Item -LiteralPath $Target -Force
Assert-NormalTarget $item $Type
if ($Action -eq 'protect') {
  Set-PrivateAcl $item $Type
  $item = Get-Item -LiteralPath $Target -Force
  Assert-NormalTarget $item $Type
}
$result = Test-PrivateAcl $item $Type
Write-Result ([bool]$result.safe) ([string]$result.reason)
