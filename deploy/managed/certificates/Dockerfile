FROM neilpang/acme.sh@sha256:5e5713c64816ca2f2dde780df87bc7464e6f6a5995d457710131b688317b8352

# The runner owns scheduling. Never download executable updates at runtime.
ENV AUTO_UPGRADE=0
COPY --chmod=0755 deploy/managed/certificates/entrypoint.sh /opt/wo/certificates.sh
ENTRYPOINT ["/opt/wo/certificates.sh"]
CMD ["daemon"]
